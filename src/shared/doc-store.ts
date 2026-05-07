import path from "node:path";
import { promises as fs } from "node:fs";
import type { DocStore } from "./types.js";
import { sha256 } from "./hash.js";
import {
  isMarkdown,
  shouldIgnore,
  toRelative,
} from "./path.js";

export type ScannerOptions = {
  shouldSync?: (relativePath: string) => boolean;
  shouldSkip?: (relativePath: string) => boolean;
};

export function createDocStore(): DocStore {
  return new Map();
}

export async function scanAll(markdownDir: string, docs: DocStore, options: ScannerOptions = {}) {
  docs.clear();
  const files = await listMarkdownFiles(markdownDir);
  await Promise.all(
    files.map(async (filePath) => {
      const relativePath = toRelative(markdownDir, filePath);
      if (!shouldInclude(relativePath, options)) return;
      await upsertDoc(markdownDir, filePath, docs);
    }),
  );
  console.log(`Scanned ${docs.size} Markdown file(s).`);
}

export async function upsertDoc(markdownDir: string, filePath: string, docs: DocStore) {
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

export function shouldInclude(relativePath: string, options: ScannerOptions) {
  if (options.shouldSkip?.(relativePath)) return false;
  return options.shouldSync ? options.shouldSync(relativePath) : true;
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

function extractTitle(markdown: string, relativePath: string) {
  const heading = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || path.basename(relativePath, path.extname(relativePath));
}
