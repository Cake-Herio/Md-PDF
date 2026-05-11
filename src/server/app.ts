import express from "express";
import type { Request, Response } from "express";
import {
  createReadStream,
  existsSync,
  promises as fs,
} from "node:fs";
import path from "node:path";
import type { AssetStore, DocMeta, DocStore, ReaderState } from "../shared/types.js";
import { buildContentDisposition } from "../shared/format.js";
import { isAssetPath, isImageAsset, isInside, normalizeRelativePath } from "../shared/path.js";
import { isPinnedPath, setPinnedPath } from "../shared/state.js";
import { upsertAsset, upsertDoc } from "../shared/doc-store.js";
import {
  deletePdfCacheForDoc,
  ensurePdf,
  getPdfCachePaths,
  getPdfJob,
  hasPdf,
  startPdfJob,
} from "./pdf.js";
import { renderIndexHtml, renderMarkdownHtml } from "./render.js";
import type { DirectoryView } from "./render.js";

type CreateAppOptions = {
  markdownDir: string;
  cacheDir: string;
  docs: DocStore;
  assets: AssetStore;
  themeCssPath?: string;
  state: ReaderState;
  saveState: () => Promise<void>;
};

export function createApp({
  markdownDir,
  cacheDir,
  docs,
  assets,
  themeCssPath,
  state,
  saveState,
}: CreateAppOptions) {
  const app = express();
  const pdfOptions = { assets, markdownDir, themeCssPath };
  app.use(express.json({ limit: "100mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/", (req, res) => {
    const currentDir = normalizeDirectoryQuery(req.query.dir);
    res.type("html").send(renderIndexHtml(buildDirectoryView(docs, currentDir, state)));
  });

  app.get("/api/files", (_req, res) => {
    res.json([...docs.values()].map(({ absolutePath: _absolutePath, ...doc }) => doc));
  });

  app.get("/api/assets", (_req, res) => {
    res.json([...assets.values()].map(({ absolutePath: _absolutePath, ...asset }) => asset));
  });

  app.post("/api/files/delete", async (req, res) => {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
    if (paths.length === 0) {
      res.status(400).json({ error: "paths must be a non-empty array." });
      return;
    }

    const results = [];
    for (const value of paths) {
      if (typeof value !== "string") continue;
      const relativePath = normalizeFileQuery(value);
      if (!relativePath) {
        results.push({ path: value, status: "invalid" });
        continue;
      }

      const deleted = await deleteServerPath(relativePath, markdownDir, cacheDir, docs);
      state.pinnedPaths = state.pinnedPaths.filter((item) => item !== relativePath && !item.startsWith(`${relativePath}/`));

      results.push({
        path: relativePath,
        status: deleted.files > 0 ? "deleted" : "not_found",
        deletedFiles: deleted.files,
        removedPdfCaches: deleted.pdfCaches,
      });
    }

    await saveState();
    res.json({ results });
  });

  app.post("/api/sync/file", async (req, res) => {
    const relativePath = normalizeFileQuery(String(req.body?.path ?? ""));
    const contentBase64 = typeof req.body?.contentBase64 === "string" ? req.body.contentBase64 : "";
    if (!relativePath || !contentBase64) {
      res.status(400).json({ error: "path and contentBase64 are required." });
      return;
    }

    const kind = getSyncFileKind(relativePath);
    if (!kind) {
      res.status(400).json({ error: "Only Markdown files and asset images can be synced." });
      return;
    }

    const absolutePath = path.resolve(markdownDir, relativePath);
    if (!isInside(markdownDir, absolutePath)) {
      res.status(400).json({ error: "Invalid path." });
      return;
    }

    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, Buffer.from(contentBase64, "base64"));

    if (kind === "markdown") {
      await upsertDoc(markdownDir, absolutePath, docs);
      const doc = docs.get(relativePath);
      if (doc) void startPdfJob(doc, cacheDir, pdfOptions);
      console.log(`Synced Markdown from agent: ${relativePath}`);
    } else {
      await upsertAsset(markdownDir, absolutePath, assets);
      for (const doc of docs.values()) void startPdfJob(doc, cacheDir, pdfOptions);
      console.log(`Synced asset from agent: ${relativePath}`);
    }

    res.json({ path: relativePath, status: "synced", kind });
  });

  app.post("/api/sync/delete", async (req, res) => {
    const paths = Array.isArray(req.body?.paths) ? req.body.paths : [];
    if (paths.length === 0) {
      res.status(400).json({ error: "paths must be a non-empty array." });
      return;
    }

    const results = [];
    for (const value of paths) {
      if (typeof value !== "string") continue;
      const relativePath = normalizeFileQuery(value);
      if (!relativePath) {
        results.push({ path: value, status: "invalid" });
        continue;
      }

      const deleted = await deleteServerPath(relativePath, markdownDir, cacheDir, docs);
      state.pinnedPaths = state.pinnedPaths.filter((item) => item !== relativePath && !item.startsWith(`${relativePath}/`));
      results.push({
        path: relativePath,
        status: deleted.files > 0 ? "deleted" : "not_found",
        deletedFiles: deleted.files,
        removedPdfCaches: deleted.pdfCaches,
      });
    }

    await saveState();
    res.json({ results });
  });

  app.post("/api/files/pin", async (req, res) => {
    const relativePath = normalizeFileQuery(String(req.body?.path ?? ""));
    if (!relativePath) {
      res.status(400).json({ error: "path is required." });
      return;
    }
    if (!docs.has(relativePath)) {
      res.status(404).json({ error: "Only Markdown files can be pinned." });
      return;
    }

    const pinned = Boolean(req.body?.pinned);
    setPinnedPath(state, relativePath, pinned);
    await saveState();
    res.json({ path: relativePath, pinned });
  });

  app.get("/view", async (req, res) => {
    const doc = getDocFromQuery(docs, req.query.path);
    if (!doc) {
      res.status(404).send("Markdown file not found.");
      return;
    }

    const markdown = await fs.readFile(doc.absolutePath, "utf8");
    const sourceUrl = `${req.protocol}://${req.get("host")}/md-file?path=${encodeURIComponent(doc.relativePath)}`;
    res.type("html").send(renderMarkdownHtml(doc, markdown, false, {
      markdownDir,
      sourceUrl,
    }));
  });

  app.get("/md-file", (req, res) => {
    const doc = getDocFromQuery(docs, req.query.path);
    if (!doc) {
      res.status(404).send("Markdown file not found.");
      return;
    }

    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition("attachment", path.basename(doc.relativePath)),
    );
    createReadStream(doc.absolutePath).pipe(res);
  });

  app.get("/pdf", async (req, res) => {
    await sendPdf(req, res, docs, cacheDir, pdfOptions, "inline");
  });

  app.get("/pdf-file", async (req, res) => {
    await sendCachedPdf(req, res, docs, cacheDir, pdfOptions, "inline");
  });

  app.get("/download", async (req, res) => {
    await sendPdf(req, res, docs, cacheDir, pdfOptions, "attachment");
  });

  app.post("/api/pdf-jobs", async (req, res) => {
    const doc = getDocFromQuery(docs, req.body?.path);
    if (!doc) {
      res.status(404).send("Markdown file not found.");
      return;
    }

    try {
      res.json(await startPdfJob(doc, cacheDir, pdfOptions));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).type("text").send(message);
    }
  });

  app.get("/api/pdf-jobs/:jobId", (req, res) => {
    const job = getPdfJob(req.params.jobId);
    if (!job) {
      res.status(404).send("PDF job not found.");
      return;
    }

    res.json(job);
  });

  app.get("/asset", async (req, res) => {
    const requested = normalizeAssetQuery(req.query.path);
    if (!requested) {
      res.status(404).send("Asset not found.");
      return;
    }
    const absolutePath = path.resolve(markdownDir, requested);
    if (!isInside(markdownDir, absolutePath) || !existsSync(absolutePath)) {
      res.status(404).send("Asset not found.");
      return;
    }
    res.sendFile(absolutePath);
  });

  return app;
}

async function sendPdf(
  req: Request,
  res: Response,
  docs: DocStore,
  cacheDir: string,
  pdfOptions: { assets: AssetStore; markdownDir: string; themeCssPath?: string },
  disposition: "inline" | "attachment",
) {
  const doc = getDocFromQuery(docs, req.query.path);
  if (!doc) {
    res.status(404).send("Markdown file not found.");
    return;
  }

  try {
    const pdfPath = await ensurePdf(doc, cacheDir, pdfOptions);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      buildContentDisposition(disposition, `${doc.title}.pdf`),
    );
    createReadStream(pdfPath).pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).type("text").send(message);
  }
}

async function sendCachedPdf(
  req: Request,
  res: Response,
  docs: DocStore,
  cacheDir: string,
  pdfOptions: { assets: AssetStore; markdownDir: string; themeCssPath?: string },
  disposition: "inline" | "attachment",
) {
  const doc = getDocFromQuery(docs, req.query.path);
  if (!doc) {
    res.status(404).send("Markdown file not found.");
    return;
  }

  if (!(await hasPdf(doc, cacheDir, pdfOptions))) {
    res.status(409).send("PDF is not ready.");
    return;
  }

  const { pdfPath } = await getPdfCachePaths(doc, cacheDir, pdfOptions);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    buildContentDisposition(disposition, `${doc.title}.pdf`),
  );
  createReadStream(pdfPath).pipe(res);
}

function getDocFromQuery(docs: DocStore, value: unknown): DocMeta | null {
  if (typeof value !== "string") return null;
  return docs.get(normalizeRelativePath(value)) ?? null;
}

function normalizeFileQuery(value: string) {
  const normalized = normalizeRelativePath(value).replace(/\/+$/g, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/");
}

function normalizeDirectoryQuery(value: unknown) {
  if (typeof value !== "string") return "";
  const normalized = normalizeRelativePath(value).replace(/\/+$/g, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return "";
  return segments.join("/");
}

function normalizeAssetQuery(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = normalizeFileQuery(value);
  if (!normalized || !isAssetPath(normalized) || !isImageAsset(normalized)) return null;
  return normalized;
}

function getSyncFileKind(relativePath: string) {
  if (/\.md$/i.test(relativePath)) return "markdown" as const;
  if (isAssetPath(relativePath) && isImageAsset(relativePath)) return "asset" as const;
  return null;
}

function isMissingFileError(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function deleteServerPath(relativePath: string, markdownDir: string, cacheDir: string, docs: DocStore) {
  const targets = [...docs.values()].filter((doc) => {
    return doc.relativePath === relativePath || doc.relativePath.startsWith(`${relativePath}/`);
  });
  let pdfCaches = 0;

  for (const doc of targets) {
    docs.delete(doc.relativePath);
    await fs.unlink(doc.absolutePath).catch((error: unknown) => {
      if (!isMissingFileError(error)) throw error;
    });
    if (await deletePdfCacheForDoc(doc.relativePath, cacheDir)) pdfCaches += 1;
  }

  await removeEmptyParents(markdownDir, path.resolve(markdownDir, relativePath));
  return { files: targets.length, pdfCaches };
}

async function removeEmptyParents(root: string, startPath: string) {
  let current = path.dirname(startPath);
  while (isInside(root, current)) {
    const entries = await fs.readdir(current).catch(() => null);
    if (!entries || entries.length > 0) return;
    await fs.rmdir(current).catch(() => undefined);
    current = path.dirname(current);
  }
}

function buildDirectoryView(docs: DocStore, currentDir: string, state: ReaderState): DirectoryView {
  const folderMap = new Map<string, { name: string; pinned: boolean; relativePath: string; docCount: number }>();
  const files: DocMeta[] = [];
  const prefix = currentDir ? `${currentDir}/` : "";
  const pinnedFiles = state.pinnedPaths
    .map((pinnedPath) => docs.get(pinnedPath))
    .filter((doc): doc is DocMeta => {
      if (!doc) return false;
      if (!currentDir) return true;
      return doc.relativePath.startsWith(prefix);
    })
    .map((doc) => ({ ...doc, pinned: true }))
    .sort(comparePinnedEntries);

  for (const doc of docs.values()) {
    if (currentDir && !doc.relativePath.startsWith(prefix)) continue;

    const remainingPath = currentDir ? doc.relativePath.slice(prefix.length) : doc.relativePath;
    if (!remainingPath) continue;

    const [firstSegment, ...rest] = remainingPath.split("/");
    if (!firstSegment) continue;

    if (rest.length === 0) {
      files.push({ ...doc, pinned: isPinnedPath(doc.relativePath, state) });
      continue;
    }

    const folderPath = prefix ? `${currentDir}/${firstSegment}` : firstSegment;
    const folder = folderMap.get(folderPath) ?? {
      name: firstSegment,
      pinned: false,
      relativePath: folderPath,
      docCount: 0,
    };
    folder.docCount += 1;
    folderMap.set(folderPath, folder);
  }

  return {
    currentDir,
    parentDir: currentDir ? currentDir.split("/").slice(0, -1).join("/") : null,
    folders: [...folderMap.values()].sort(comparePinnedEntries),
    files: files.sort(comparePinnedEntries),
    pinnedFiles,
    pinnedPaths: state.pinnedPaths,
    totalDocs: docs.size,
  };
}

function comparePinnedEntries(a: { pinned?: boolean; relativePath: string }, b: { pinned?: boolean; relativePath: string }) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  return a.relativePath.localeCompare(b.relativePath, "zh-Hans-CN");
}
