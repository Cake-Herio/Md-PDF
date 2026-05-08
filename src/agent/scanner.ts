import chokidar from "chokidar";
import type { AssetStore, DocStore } from "../shared/types.js";
import {
  isAssetPath,
  isImageAsset,
  isMarkdown,
  shouldIgnore,
  toRelative,
} from "../shared/path.js";
import type { ScannerOptions } from "../shared/doc-store.js";
import {
  shouldInclude,
  upsertAsset,
  upsertDoc,
} from "../shared/doc-store.js";

type WatchOptions = ScannerOptions & {
  onDelete?: (relativePath: string) => void | Promise<void>;
  assets?: AssetStore;
  onAssetDelete?: (relativePath: string) => void | Promise<void>;
};

export function watchMarkdownDir(markdownDir: string, docs: DocStore, options: WatchOptions = {}) {
  const pending = new Map<string, NodeJS.Timeout>();
  const watcher = chokidar.watch(markdownDir, {
    ignoreInitial: true,
    ignored: (filePath) => shouldIgnore(filePath, markdownDir),
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher
    .on("add", (filePath) => scheduleRefresh(markdownDir, filePath, docs, pending, options))
    .on("change", (filePath) => scheduleRefresh(markdownDir, filePath, docs, pending, options))
    .on("unlink", (filePath) => void removeDoc(markdownDir, filePath, docs, options));

  return watcher;
}

function scheduleRefresh(
  markdownDir: string,
  filePath: string,
  docs: DocStore,
  pending: Map<string, NodeJS.Timeout>,
  options: WatchOptions,
) {
  const key = toRelative(markdownDir, filePath);
  if (shouldIgnore(filePath, markdownDir)) return;
  if (isAssetPath(key) && isImageAsset(key)) {
    scheduleAssetRefresh(markdownDir, filePath, key, pending, options);
    return;
  }

  if (!isMarkdown(filePath)) return;
  if (!shouldInclude(key, options)) return;
  const oldTimer = pending.get(key);
  if (oldTimer) clearTimeout(oldTimer);

  pending.set(
    key,
    setTimeout(async () => {
      pending.delete(key);
      await upsertDoc(markdownDir, filePath, docs).catch((error) => {
        console.error(`Failed to refresh ${key}:`, error);
      });
    }, 700),
  );
}

function scheduleAssetRefresh(
  markdownDir: string,
  filePath: string,
  key: string,
  pending: Map<string, NodeJS.Timeout>,
  options: WatchOptions,
) {
  if (!options.assets) return;
  const oldTimer = pending.get(key);
  if (oldTimer) clearTimeout(oldTimer);

  pending.set(
    key,
    setTimeout(async () => {
      pending.delete(key);
      await upsertAsset(markdownDir, filePath, options.assets!).catch((error) => {
        console.error(`Failed to refresh asset ${key}:`, error);
      });
    }, 700),
  );
}

async function removeDoc(markdownDir: string, filePath: string, docs: DocStore, options: WatchOptions) {
  const relativePath = toRelative(markdownDir, filePath);
  if (isAssetPath(relativePath) && isImageAsset(relativePath)) {
    options.assets?.delete(relativePath);
    await options.onAssetDelete?.(relativePath);
    console.log(`Removed asset: ${relativePath}`);
    return;
  }

  if (!isMarkdown(filePath)) return;
  docs.delete(relativePath);
  if (shouldInclude(relativePath, options)) {
    await options.onDelete?.(relativePath);
  }
  console.log(`Removed: ${relativePath}`);
}

