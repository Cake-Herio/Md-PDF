import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants,
  existsSync,
  promises as fs,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { AssetStore, DocMeta } from "../shared/types.js";
import { sha256 } from "../shared/hash.js";
import { renderMarkdownHtml } from "./render.js";

export type PdfJobStatus = "pending" | "rendering" | "done" | "error";

export type PdfJobSnapshot = {
  jobId: string;
  status: PdfJobStatus;
  progress: number;
  message: string;
  pdfUrl?: string;
  error?: string;
};

type PdfJob = PdfJobSnapshot & {
  cacheKey: string;
  pdfPath?: string;
};

export type PdfOptions = {
  assets?: AssetStore;
  markdownDir?: string;
  themeCssPath?: string;
};

type PdfTheme = {
  css: string;
  cacheHash: string;
};

type PdfCacheIndex = Record<string, string>;

const jobs = new Map<string, PdfJob>();
const jobIdsByCacheKey = new Map<string, string>();
const PDF_RENDER_VERSION = "asset-root-v2";
const PDF_CACHE_INDEX_FILE = "index.json";
let pdfCacheIndexQueue = Promise.resolve();

export async function getPdfCachePaths(doc: DocMeta, cacheDir: string, options: PdfOptions = {}) {
  const theme = await loadPdfTheme(options);
  const safeName = getPdfCacheKey(doc, theme, options);
  return {
    htmlPath: path.join(cacheDir, `${safeName}.html`),
    pdfPath: path.join(cacheDir, `${safeName}.pdf`),
  };
}

export async function hasPdf(doc: DocMeta, cacheDir: string, options: PdfOptions = {}) {
  return existsSync((await getPdfCachePaths(doc, cacheDir, options)).pdfPath);
}

export async function deletePdfCacheForDoc(relativePath: string, cacheDir: string) {
  const index = await loadPdfCacheIndex(cacheDir);
  const cacheKey = index[relativePath];
  if (!cacheKey) return false;

  await deletePdfCachePair(cacheDir, cacheKey);
  delete index[relativePath];
  jobIdsByCacheKey.delete(cacheKey);
  jobs.delete(cacheKey);
  await savePdfCacheIndex(cacheDir, index);
  return true;
}

export async function startPdfJob(
  doc: DocMeta,
  cacheDir: string,
  options: PdfOptions = {},
): Promise<PdfJobSnapshot> {
  const theme = await loadPdfTheme(options);
  const cacheKey = getPdfCacheKey(doc, theme, options);
  await preparePdfCacheSlot(doc, cacheDir, cacheKey);
  const existingJobId = jobIdsByCacheKey.get(cacheKey);
  if (existingJobId) {
    const existingJob = jobs.get(existingJobId);
    if (existingJob) return toSnapshot(existingJob);
  }

  const { pdfPath } = getPdfCachePathsByKey(cacheDir, cacheKey);
  const jobId = cacheKey;
  const job: PdfJob = existsSync(pdfPath)
    ? {
        jobId,
        cacheKey,
        status: "done",
        progress: 100,
        message: "PDF 已缓存，即将打开。",
        pdfPath,
        pdfUrl: buildPdfUrl(doc),
      }
    : {
        jobId,
        cacheKey,
        status: "pending",
        progress: 10,
        message: "正在准备生成 PDF...",
      };

  jobs.set(jobId, job);
  jobIdsByCacheKey.set(cacheKey, jobId);

  if (job.status !== "done") {
    void runPdfJob(job, doc, cacheDir, theme, options);
  }

  return toSnapshot(job);
}

export function getPdfJob(jobId: string): PdfJobSnapshot | null {
  const job = jobs.get(jobId);
  return job ? toSnapshot(job) : null;
}

export async function ensurePdf(doc: DocMeta, cacheDir: string, options: PdfOptions = {}) {
  const theme = await loadPdfTheme(options);
  return ensurePdfWithTheme(doc, cacheDir, theme, options);
}

async function ensurePdfWithTheme(
  doc: DocMeta,
  cacheDir: string,
  theme: PdfTheme | null,
  options: PdfOptions,
) {
  const cacheKey = getPdfCacheKey(doc, theme, options);
  await preparePdfCacheSlot(doc, cacheDir, cacheKey);
  const { htmlPath, pdfPath } = getPdfCachePathsByKey(cacheDir, cacheKey);

  if (existsSync(pdfPath)) return pdfPath;

  const markdown = await fs.readFile(doc.absolutePath, "utf8");
  const html = renderMarkdownHtml(doc, markdown, true, {
    markdownDir: options.markdownDir,
    themeCss: theme?.css,
  });
  await fs.writeFile(htmlPath, html, "utf8");

  const browserPath = await findBrowser();
  if (!browserPath) {
    throw new Error(
      "未找到 Microsoft Edge 或 Chrome，无法生成 PDF。请安装浏览器，或设置 BROWSER_PATH 环境变量。",
    );
  }

  await printToPdf(browserPath, htmlPath, pdfPath);
  return pdfPath;
}

async function preparePdfCacheSlot(doc: DocMeta, cacheDir: string, cacheKey: string) {
  await withPdfCacheIndexLock(async () => {
    const index = await loadPdfCacheIndex(cacheDir);
    const oldCacheKey = index[doc.relativePath];

    if (oldCacheKey && oldCacheKey !== cacheKey) {
      await deletePdfCachePair(cacheDir, oldCacheKey);
      jobIdsByCacheKey.delete(oldCacheKey);
      jobs.delete(oldCacheKey);
    }

    if (oldCacheKey !== cacheKey) {
      index[doc.relativePath] = cacheKey;
      await savePdfCacheIndex(cacheDir, index);
    }

    await deleteUnindexedPdfCaches(cacheDir, new Set(Object.values(index)));
  });
}

async function withPdfCacheIndexLock<T>(task: () => Promise<T>) {
  const run = pdfCacheIndexQueue.then(task, task);
  pdfCacheIndexQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function deletePdfCachePair(cacheDir: string, cacheKey: string) {
  const { htmlPath, pdfPath } = getPdfCachePathsByKey(cacheDir, cacheKey);
  await Promise.all([
    fs.unlink(htmlPath).catch((error: unknown) => {
      if (!isMissingFileError(error)) throw error;
    }),
    fs.unlink(pdfPath).catch((error: unknown) => {
      if (!isMissingFileError(error)) throw error;
    }),
  ]);
}

async function deleteUnindexedPdfCaches(cacheDir: string, activeCacheKeys: Set<string>) {
  const entries = await fs.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const parsed = path.parse(entry.name);
      if (parsed.ext !== ".html" && parsed.ext !== ".pdf") return;
      if (activeCacheKeys.has(parsed.name)) return;

      await fs.unlink(path.join(cacheDir, entry.name)).catch((error: unknown) => {
        if (!isMissingFileError(error)) throw error;
      });
    }),
  );
}

async function loadPdfCacheIndex(cacheDir: string): Promise<PdfCacheIndex> {
  const indexPath = path.join(cacheDir, PDF_CACHE_INDEX_FILE);
  const raw = await fs.readFile(indexPath, "utf8").catch(() => null);
  if (!raw) return {};

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function savePdfCacheIndex(cacheDir: string, index: PdfCacheIndex) {
  await fs.mkdir(cacheDir, { recursive: true });
  const indexPath = path.join(cacheDir, PDF_CACHE_INDEX_FILE);
  const tempPath = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, indexPath);
}

function isMissingFileError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function getPdfCachePathsByKey(cacheDir: string, cacheKey: string) {
  return {
    htmlPath: path.join(cacheDir, `${cacheKey}.html`),
    pdfPath: path.join(cacheDir, `${cacheKey}.pdf`),
  };
}

function getPdfCacheKey(doc: DocMeta, theme: PdfTheme | null, options: PdfOptions = {}) {
  const assetHash = getAssetCacheHash(options.assets);
  if (!theme) {
    return sha256(Buffer.from(`${PDF_RENDER_VERSION}:${doc.relativePath}:${doc.hash}:assets:${assetHash}`));
  }
  return sha256(
    Buffer.from(`${PDF_RENDER_VERSION}:${doc.relativePath}:${doc.hash}:theme:${theme.cacheHash}:assets:${assetHash}`),
  );
}

function getAssetCacheHash(assets?: AssetStore) {
  if (!assets || assets.size === 0) return "";
  return [...assets.values()]
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((asset) => `${asset.relativePath}:${asset.hash}`)
    .join("|");
}

async function loadPdfTheme(options: PdfOptions): Promise<PdfTheme | null> {
  if (!options.themeCssPath) return null;

  const css = await fs.readFile(options.themeCssPath, "utf8").catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取 Typora 主题 CSS：${options.themeCssPath}。${message}`);
  });

  const cacheHash = sha256(Buffer.from(`${options.themeCssPath}:${css}`));
  return {
    css,
    cacheHash,
  };
}

async function runPdfJob(
  job: PdfJob,
  doc: DocMeta,
  cacheDir: string,
  theme: PdfTheme | null,
  options: PdfOptions,
) {
  try {
    job.status = "rendering";
    job.progress = 60;
    job.message = "正在渲染 PDF...";

    job.pdfPath = await ensurePdfWithTheme(doc, cacheDir, theme, options);
    job.status = "done";
    job.progress = 100;
    job.message = "生成完成，即将打开。";
    job.pdfUrl = buildPdfUrl(doc);
  } catch (error) {
    job.status = "error";
    job.progress = 100;
    job.message = "PDF 生成失败。";
    job.error = error instanceof Error ? error.message : String(error);
  }
}

function toSnapshot(job: PdfJob): PdfJobSnapshot {
  return {
    jobId: job.jobId,
    status: job.status,
    progress: job.progress,
    message: job.message,
    pdfUrl: job.pdfUrl,
    error: job.error,
  };
}

function buildPdfUrl(doc: DocMeta) {
  return `/pdf-file?path=${encodeURIComponent(doc.relativePath)}`;
}

async function printToPdf(browserPath: string, htmlPath: string, pdfPath: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(browserPath, [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-extensions",
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ]);

    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0 && existsSync(pdfPath)) {
        resolve();
      } else {
        reject(new Error(`PDF 生成失败。${stderr}`));
      }
    });
  });
}

async function findBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next known browser path.
    }
  }
  return null;
}
