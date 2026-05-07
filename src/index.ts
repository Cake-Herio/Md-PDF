import chokidar from "chokidar";
import express from "express";
import type { Request, Response } from "express";
import { marked } from "marked";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  constants,
  createReadStream,
  existsSync,
  promises as fs,
} from "node:fs";

type DocMeta = {
  relativePath: string;
  absolutePath: string;
  title: string;
  size: number;
  mtimeMs: number;
  hash: string;
};

const appRoot = process.cwd();
const cacheDir = path.join(appRoot, ".md-local-reader", "pdf-cache");
const docs = new Map<string, DocMeta>();
const pending = new Map<string, NodeJS.Timeout>();

marked.setOptions({
  gfm: true,
  breaks: false,
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port ?? 3000);
  const markdownDir = await resolveMarkdownDir(args.dir);

  await fs.mkdir(cacheDir, { recursive: true });
  await scanAll(markdownDir);

  const app = createApp(markdownDir);
  const server = createServer(app);

  server.listen(port, "0.0.0.0", () => {
    console.log("");
    console.log(`Markdown folder: ${markdownDir}`);
    console.log(`Local address:   http://localhost:${port}`);
    for (const ip of getLanIPv4()) {
      console.log(`Phone address:   http://${ip}:${port}`);
    }
    console.log("");
    console.log("Keep this terminal open. Press Ctrl+C to stop.");
  });

  const watcher = chokidar.watch(markdownDir, {
    ignoreInitial: true,
    ignored: (filePath) => shouldIgnore(filePath, markdownDir),
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher
    .on("add", (filePath) => scheduleRefresh(markdownDir, filePath))
    .on("change", (filePath) => scheduleRefresh(markdownDir, filePath))
    .on("unlink", (filePath) => removeDoc(markdownDir, filePath));
}

function createApp(markdownDir: string) {
  const app = express();

  app.get("/", (_req, res) => {
    const list = [...docs.values()].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath, "zh-Hans-CN"),
    );

    res.type("html").send(renderIndexHtml(list));
  });

  app.get("/api/files", (_req, res) => {
    res.json([...docs.values()].map(({ absolutePath: _absolutePath, ...doc }) => doc));
  });

  app.get("/view", async (req, res) => {
    const doc = getDocFromQuery(req.query.path);
    if (!doc) {
      res.status(404).send("Markdown file not found.");
      return;
    }

    const markdown = await fs.readFile(doc.absolutePath, "utf8");
    res.type("html").send(renderMarkdownHtml(doc, markdown, false));
  });

  app.get("/pdf", async (req, res) => {
    await sendPdf(req, res, "inline");
  });

  app.get("/download", async (req, res) => {
    await sendPdf(req, res, "attachment");
  });

  app.get("/asset", async (req, res) => {
    const requested = String(req.query.path ?? "");
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
  disposition: "inline" | "attachment",
) {
  const doc = getDocFromQuery(req.query.path);
  if (!doc) {
    res.status(404).send("Markdown file not found.");
    return;
  }

  try {
    const pdfPath = await ensurePdf(doc);
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

async function resolveMarkdownDir(inputDir?: string) {
  let dir = inputDir?.trim();
  if (!dir) {
    const rl = createInterface({ input, output });
    dir = await rl.question("请输入 Markdown 文件夹路径: ");
    rl.close();
  }

  const resolved = path.resolve(dir.replace(/^"|"$/g, ""));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

async function scanAll(markdownDir: string) {
  docs.clear();
  const files = await listMarkdownFiles(markdownDir);
  await Promise.all(files.map((filePath) => upsertDoc(markdownDir, filePath)));
  console.log(`Scanned ${docs.size} Markdown file(s).`);
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (shouldIgnore(absolutePath, dir)) continue;

    if (entry.isDirectory()) {
      result.push(...(await listMarkdownFiles(absolutePath)));
    } else if (isMarkdown(absolutePath)) {
      result.push(absolutePath);
    }
  }

  return result;
}

function scheduleRefresh(markdownDir: string, filePath: string) {
  if (!isMarkdown(filePath) || shouldIgnore(filePath, markdownDir)) return;

  const key = toRelative(markdownDir, filePath);
  const oldTimer = pending.get(key);
  if (oldTimer) clearTimeout(oldTimer);

  pending.set(
    key,
    setTimeout(async () => {
      pending.delete(key);
      await upsertDoc(markdownDir, filePath).catch((error) => {
        console.error(`Failed to refresh ${key}:`, error);
      });
    }, 700),
  );
}

async function upsertDoc(markdownDir: string, filePath: string) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) return;

  const content = await fs.readFile(filePath);
  const relativePath = toRelative(markdownDir, filePath);
  const title = extractTitle(content.toString("utf8"), relativePath);
  const hash = sha256(content);

  docs.set(relativePath, {
    relativePath,
    absolutePath: filePath,
    title,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    hash,
  });

  console.log(`Updated: ${relativePath}`);
}

function removeDoc(markdownDir: string, filePath: string) {
  const relativePath = toRelative(markdownDir, filePath);
  docs.delete(relativePath);
  console.log(`Removed: ${relativePath}`);
}

async function ensurePdf(doc: DocMeta) {
  const safeName = sha256(Buffer.from(`${doc.relativePath}:${doc.hash}`));
  const htmlPath = path.join(cacheDir, `${safeName}.html`);
  const pdfPath = path.join(cacheDir, `${safeName}.pdf`);

  if (existsSync(pdfPath)) return pdfPath;

  const markdown = await fs.readFile(doc.absolutePath, "utf8");
  const html = renderMarkdownHtml(doc, markdown, true);
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

function renderIndexHtml(list: DocMeta[]) {
  const items = list
    .map((doc) => {
      const encoded = encodeURIComponent(doc.relativePath);
      const updated = new Date(doc.mtimeMs).toLocaleString();
      return `<li class="doc-item" data-text="${escapeHtml(`${doc.title} ${doc.relativePath}`)}">
        <a class="title" href="/pdf?path=${encoded}">${escapeHtml(doc.title)}</a>
        <div class="path">${escapeHtml(doc.relativePath)}</div>
        <div class="meta">${formatBytes(doc.size)} · ${updated}</div>
        <div class="actions">
          <a href="/pdf?path=${encoded}">打开 PDF</a>
          <a href="/view?path=${encoded}">预览 MD</a>
        </div>
      </li>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Markdown PDF Reader</title>
  ${styleTag()}
</head>
<body>
  <main class="shell">
    <header class="hero">
      <h1>Markdown PDF Reader</h1>
      <p>${list.length} 个 Markdown 文件。点击标题会直接打开 PDF，适合 iPhone 阅读。</p>
      <input id="search" type="search" placeholder="搜索文件名或路径" autocomplete="off" />
    </header>
    <ul id="docs" class="doc-list">${items || `<li class="empty">当前目录下没有 .md 文件。</li>`}</ul>
  </main>
  <script>
    const search = document.querySelector("#search");
    const items = [...document.querySelectorAll(".doc-item")];
    search?.addEventListener("input", () => {
      const keyword = search.value.trim().toLowerCase();
      for (const item of items) {
        item.hidden = !item.dataset.text.toLowerCase().includes(keyword);
      }
    });
  </script>
</body>
</html>`;
}

function renderMarkdownHtml(doc: DocMeta, markdown: string, forPdf: boolean) {
  const baseHref = pathToFileURL(path.dirname(doc.absolutePath) + path.sep).href;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base href="${baseHref}" />
  <title>${escapeHtml(doc.title)}</title>
  ${styleTag()}
</head>
<body class="${forPdf ? "pdf" : ""}">
  <article class="markdown-body">
    ${marked.parse(markdown)}
  </article>
</body>
</html>`;
}

function styleTag() {
  return `<style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f7f9;
      color: #1f2328;
    }
    body {
      margin: 0;
      background: #f6f7f9;
    }
    .shell {
      max-width: 880px;
      margin: 0 auto;
      padding: 24px 14px 48px;
    }
    .hero {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 18px;
      padding: 20px;
      box-shadow: 0 8px 30px rgba(15, 23, 42, 0.06);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 26px;
    }
    .hero p {
      margin: 0 0 16px;
      color: #5f6b7a;
      line-height: 1.6;
    }
    input[type="search"] {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #d0d7de;
      border-radius: 12px;
      padding: 13px 14px;
      font-size: 16px;
      outline: none;
    }
    .doc-list {
      list-style: none;
      margin: 14px 0 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    .doc-item, .empty {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      padding: 16px;
    }
    .title {
      display: block;
      color: #0969da;
      font-size: 18px;
      font-weight: 700;
      text-decoration: none;
      line-height: 1.45;
    }
    .path, .meta {
      margin-top: 6px;
      color: #667085;
      font-size: 13px;
      word-break: break-all;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .actions a {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      border: 1px solid #d0d7de;
      border-radius: 999px;
      padding: 0 13px;
      color: #0969da;
      background: #f6f8fa;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
    }
    .markdown-body {
      box-sizing: border-box;
      max-width: 820px;
      margin: 0 auto;
      padding: 42px 24px 70px;
      background: #fff;
      color: #24292f;
      line-height: 1.75;
      font-size: 16px;
    }
    .markdown-body h1, .markdown-body h2, .markdown-body h3 {
      line-height: 1.3;
      margin-top: 1.6em;
    }
    .markdown-body h1 {
      font-size: 30px;
      border-bottom: 1px solid #d8dee4;
      padding-bottom: 0.3em;
    }
    .markdown-body h2 {
      font-size: 24px;
      border-bottom: 1px solid #d8dee4;
      padding-bottom: 0.25em;
    }
    .markdown-body img {
      max-width: 100%;
    }
    .markdown-body code {
      background: #f6f8fa;
      border-radius: 6px;
      padding: 0.15em 0.35em;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 0.92em;
    }
    .markdown-body pre {
      overflow: auto;
      background: #f6f8fa;
      border-radius: 10px;
      padding: 16px;
      line-height: 1.55;
    }
    .markdown-body pre code {
      padding: 0;
      background: transparent;
    }
    .markdown-body blockquote {
      margin: 1em 0;
      padding: 0 1em;
      color: #57606a;
      border-left: 0.25em solid #d0d7de;
    }
    .markdown-body table {
      display: block;
      width: 100%;
      overflow: auto;
      border-collapse: collapse;
    }
    .markdown-body th, .markdown-body td {
      border: 1px solid #d0d7de;
      padding: 6px 10px;
    }
    .pdf .markdown-body {
      max-width: none;
      padding: 0;
      font-size: 15px;
    }
    @page {
      size: A4;
      margin: 18mm 16mm;
    }
    @media (max-width: 640px) {
      .shell {
        padding: 12px 10px 32px;
      }
      .hero {
        padding: 16px;
        border-radius: 14px;
      }
      h1 {
        font-size: 22px;
      }
      .markdown-body {
        padding: 24px 16px 48px;
        font-size: 16px;
      }
    }
  </style>`;
}

function getDocFromQuery(value: unknown) {
  if (typeof value !== "string") return null;
  return docs.get(normalizeRelativePath(value)) ?? null;
}

function extractTitle(markdown: string, relativePath: string) {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(relativePath, path.extname(relativePath));
}

function parseArgs(args: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dir" && args[i + 1]) result.dir = args[++i];
    if (arg === "--port" && args[i + 1]) result.port = args[++i];
  }
  return result;
}

function getLanIPv4() {
  return Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

function shouldIgnore(filePath: string, root: string) {
  const relative = toRelative(root, filePath);
  const segments = relative.split("/");
  return segments.some((segment) => {
    return (
      segment === "node_modules" ||
      segment === ".git" ||
      segment === ".md-local-reader" ||
      segment.startsWith(".") ||
      segment.endsWith(".tmp") ||
      segment.endsWith(".swp") ||
      segment.startsWith("~$")
    );
  });
}

function isMarkdown(filePath: string) {
  return /\.md$/i.test(filePath);
}

function toRelative(root: string, filePath: string) {
  return normalizeRelativePath(path.relative(root, filePath));
}

function normalizeRelativePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\/+/, "");
}

function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function sha256(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}

function buildContentDisposition(disposition: "inline" | "attachment", filename: string) {
  const asciiName = sanitizeFilename(filename);
  const encodedName = encodeURIComponent(filename);
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

function sanitizeFilename(filename: string) {
  return filename
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 120);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
