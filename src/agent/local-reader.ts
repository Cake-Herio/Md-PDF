import { createServer } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fs } from "node:fs";
import { createApp } from "../server/app.js";
import {
  createAssetStore,
  createDocStore,
  scanAll,
  scanAllAssets,
} from "../shared/doc-store.js";
import {
  watchMarkdownDir,
} from "./scanner.js";
import {
  addDeletionRecord,
  createDeletionRecord,
  isDeletedPath,
  isSelectedPath,
  loadReaderState,
  processPendingDeletions,
  saveReaderState,
} from "../shared/state.js";
import { isMarkdown, shouldIgnore, toRelative } from "../shared/path.js";

const appRoot = process.cwd();
const stateDir = path.join(appRoot, ".md-local-reader");
const cacheDir = path.join(stateDir, "pdf-cache");
const statePath = path.join(stateDir, "state.json");
const trashDir = path.join(stateDir, "trash");

export async function startLocalReader() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port ?? 3000);
  const markdownDir = await resolveMarkdownDir(args.dir);
  const themeCssPath = await resolveOptionalFile(args.themeCss ?? process.env.TYPORA_THEME_CSS);
  const state = await loadReaderState(statePath);
  const docs = createDocStore();
  const assets = createAssetStore();

  await fs.mkdir(cacheDir, { recursive: true });
  if (await processPendingDeletions(markdownDir, trashDir, state)) {
    await saveReaderState(statePath, state);
  }

  state.selectedPaths = await chooseSelectedPaths(markdownDir, state.selectedPaths, args.sync);
  await saveReaderState(statePath, state);

  const scannerOptions = {
    shouldSync: (relativePath: string) => isSelectedPath(relativePath, state.selectedPaths),
    shouldSkip: (relativePath: string) => isDeletedPath(relativePath, state),
  };

  await scanAll(markdownDir, docs, scannerOptions);
  await scanAllAssets(markdownDir, assets);

  const app = createApp({
    markdownDir,
    cacheDir,
    docs,
    assets,
    themeCssPath,
    state,
    saveState: () => saveReaderState(statePath, state),
  });
  const server = createServer(app);

  server.listen(port, "0.0.0.0", () => {
    console.log("");
    console.log(`Markdown folder: ${markdownDir}`);
    console.log(`Sync selection:  ${formatSelection(state.selectedPaths)}`);
    if (themeCssPath) console.log(`Typora theme CSS: ${themeCssPath}`);
    console.log(`Local address:   http://localhost:${port}`);
    for (const ip of getLanIPv4()) {
      console.log(`Phone address:   http://${ip}:${port}`);
    }
    console.log("");
    console.log("Keep this terminal open. Press Ctrl+C to stop.");
  });

  watchMarkdownDir(markdownDir, docs, {
    ...scannerOptions,
    assets,
    onDelete: async (relativePath) => {
      const deletion = createDeletionRecord(relativePath, "local", state.deviceId);
      addDeletionRecord(state, deletion);
      await saveReaderState(statePath, state);
      console.log(`Synced local delete tombstone: ${relativePath}`);
    },
    onAssetDelete: async (relativePath) => {
      console.log(`Detected local asset delete: ${relativePath}`);
    },
  });
}

async function resolveMarkdownDir(inputDir?: string) {
  const dir = inputDir?.trim() || await resolveDesktopDir();

  const resolved = path.resolve(dir.replace(/^"|"$/g, ""));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

async function resolveDesktopDir() {
  const candidates = [
    path.join(homedir(), "Desktop"),
    path.join(homedir(), "桌面"),
  ];

  for (const candidate of candidates) {
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isDirectory()) return candidate;
  }

  return candidates[0];
}

async function resolveOptionalFile(inputPath?: string) {
  const filePath = inputPath?.trim();
  if (!filePath) return undefined;

  const resolved = path.resolve(filePath.replace(/^"|"$/g, ""));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error(`Not a file: ${resolved}`);
  }
  return resolved;
}

function parseArgs(args: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dir" && args[i + 1]) result.dir = args[++i];
    if (arg === "--port" && args[i + 1]) result.port = args[++i];
    if (arg === "--theme-css" && args[i + 1]) result.themeCss = args[++i];
    if (arg === "--sync" && args[i + 1]) result.sync = args[++i];
  }
  return result;
}

async function chooseSelectedPaths(markdownDir: string, currentSelection: string[], syncArg?: string) {
  if (syncArg === "all") return ["*"];
  if (syncArg) return syncArg.split(",").map((item) => item.trim()).filter(Boolean);

  if (currentSelection.length > 0) {
    const rl = createInterface({ input, output });
    const answer = await rl.question(`继续使用上次同步范围 (${formatSelection(currentSelection)})？[Y/n]: `);
    rl.close();
    if (!/^n/i.test(answer.trim())) return currentSelection;
  }

  const markdownFiles = await listMarkdownFiles(markdownDir);
  if (markdownFiles.length === 0) return [];

  const choices = buildSelectionChoices(markdownFiles);
  console.log("");
  console.log("请选择要同步/监听的 Markdown 文件或文件夹：");
  console.log("0. 全部 Markdown 文件");
  choices.forEach((choice, index) => {
    console.log(`${index + 1}. [${choice.type === "folder" ? "目录" : "文件"}] ${choice.path}`);
  });

  const rl = createInterface({ input, output });
  const answer = await rl.question("输入编号（可用逗号分隔，例如 1,3,5；直接回车选择全部）: ");
  rl.close();

  const trimmed = answer.trim();
  if (!trimmed || trimmed === "0" || /^all$/i.test(trimmed)) return ["*"];

  const selected = new Set<string>();
  for (const token of trimmed.split(",")) {
    const index = Number(token.trim());
    if (!Number.isInteger(index) || index < 1 || index > choices.length) continue;
    selected.add(choices[index - 1].path);
  }

  return selected.size > 0 ? [...selected] : ["*"];
}

async function listMarkdownFiles(root: string, dir = root): Promise<string[]> {
  const result: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (shouldIgnore(absolutePath, root)) continue;

    if (entry.isDirectory()) {
      result.push(...(await listMarkdownFiles(root, absolutePath)));
    } else if (isMarkdown(absolutePath)) {
      result.push(toRelative(root, absolutePath));
    }
  }

  return result.sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function buildSelectionChoices(markdownFiles: string[]) {
  const folders = new Set<string>();
  for (const file of markdownFiles) {
    const segments = file.split("/");
    for (let i = 1; i < segments.length; i += 1) {
      folders.add(segments.slice(0, i).join("/"));
    }
  }

  return [
    ...[...folders].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")).map((item) => ({
      type: "folder" as const,
      path: item,
    })),
    ...markdownFiles.map((item) => ({
      type: "file" as const,
      path: item,
    })),
  ];
}

function formatSelection(selectedPaths: string[]) {
  if (selectedPaths.includes("*")) return "全部 Markdown 文件";
  return selectedPaths.length > 0 ? selectedPaths.join(", ") : "未选择";
}

function getLanIPv4() {
  return Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}
