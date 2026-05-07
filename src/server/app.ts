import express from "express";
import type { Request, Response } from "express";
import {
  createReadStream,
  existsSync,
  promises as fs,
} from "node:fs";
import path from "node:path";
import type { DocMeta, DocStore, ReaderState } from "../shared/types.js";
import { buildContentDisposition } from "../shared/format.js";
import { isInside, normalizeRelativePath } from "../shared/path.js";
import { addDeletionRecord, createDeletionRecord } from "../shared/state.js";
import {
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
  themeCssPath?: string;
  state: ReaderState;
  saveState: () => Promise<void>;
};

export function createApp({
  markdownDir,
  cacheDir,
  docs,
  themeCssPath,
  state,
  saveState,
}: CreateAppOptions) {
  const app = express();
  const pdfOptions = { themeCssPath };
  app.use(express.json());

  app.get("/", (req, res) => {
    const currentDir = normalizeDirectoryQuery(req.query.dir);
    res.type("html").send(renderIndexHtml(buildDirectoryView(docs, currentDir)));
  });

  app.get("/api/files", (_req, res) => {
    res.json([...docs.values()].map(({ absolutePath: _absolutePath, ...doc }) => doc));
  });

  app.get("/api/deletions", (req, res) => {
    const since = Number(req.query.since ?? 0);
    const deletions = state.deletions.filter((deletion) => deletion.deletedAt > since);
    res.json({ deletions });
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

      const existed = docs.delete(relativePath);
      const deletion = addDeletionRecord(
        state,
        createDeletionRecord(relativePath, "mobile", state.deviceId),
      );

      results.push({
        path: relativePath,
        status: existed ? "deleted" : "not_found",
        deletionId: deletion.id,
      });
    }

    await saveState();
    res.json({ results });
  });

  app.get("/view", async (req, res) => {
    const doc = getDocFromQuery(docs, req.query.path);
    if (!doc) {
      res.status(404).send("Markdown file not found.");
      return;
    }

    const markdown = await fs.readFile(doc.absolutePath, "utf8");
    res.type("html").send(renderMarkdownHtml(doc, markdown, false));
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
  docs: DocStore,
  cacheDir: string,
  pdfOptions: { themeCssPath?: string },
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
  pdfOptions: { themeCssPath?: string },
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

function buildDirectoryView(docs: DocStore, currentDir: string): DirectoryView {
  const folderMap = new Map<string, { name: string; relativePath: string; docCount: number }>();
  const files: DocMeta[] = [];
  const prefix = currentDir ? `${currentDir}/` : "";

  for (const doc of docs.values()) {
    if (currentDir && !doc.relativePath.startsWith(prefix)) continue;

    const remainingPath = currentDir ? doc.relativePath.slice(prefix.length) : doc.relativePath;
    if (!remainingPath) continue;

    const [firstSegment, ...rest] = remainingPath.split("/");
    if (!firstSegment) continue;

    if (rest.length === 0) {
      files.push(doc);
      continue;
    }

    const folderPath = prefix ? `${currentDir}/${firstSegment}` : firstSegment;
    const folder = folderMap.get(folderPath) ?? {
      name: firstSegment,
      relativePath: folderPath,
      docCount: 0,
    };
    folder.docCount += 1;
    folderMap.set(folderPath, folder);
  }

  return {
    currentDir,
    parentDir: currentDir ? currentDir.split("/").slice(0, -1).join("/") : null,
    folders: [...folderMap.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN")),
    files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, "zh-Hans-CN")),
    totalDocs: docs.size,
  };
}
