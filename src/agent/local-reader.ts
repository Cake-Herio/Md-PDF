import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fs } from "node:fs";
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
  isSelectedPath,
  loadReaderState,
  saveReaderState,
} from "../shared/state.js";
import { isMarkdown, shouldIgnore, toRelative } from "../shared/path.js";
import type { AssetMeta, DocMeta } from "../shared/types.js";

type RemoteFile = Omit<DocMeta, "absolutePath">;
type RemoteAsset = Omit<AssetMeta, "absolutePath">;
type RemoteChoice = {
  type: "folder" | "file";
  path: string;
};

const appRoot = process.cwd();
const stateDir = path.join(appRoot, ".md-local-reader");
const statePath = path.join(stateDir, "state.json");

export async function startLocalReader() {
  const args = parseArgs(process.argv.slice(2));
  const markdownDir = await resolveMarkdownDir(args.dir);
  const state = await loadReaderState(statePath);
  const serverUrl = await resolveServerUrl(args.server, state.serverUrl);
  state.serverUrl = serverUrl;

  const docs = createDocStore();
  const assets = createAssetStore();

  await assertServerReachable(serverUrl);
  await pullServerFiles(markdownDir, serverUrl);

  state.selectedPaths = await chooseSelectedPaths(markdownDir, state.selectedPaths, args.sync);
  await saveReaderState(statePath, state);

  const scannerOptions = {
    shouldSync: (relativePath: string) => isSelectedPath(relativePath, state.selectedPaths),
  };

  const shouldSyncAssets = state.selectedPaths.length > 0;
  await scanAll(markdownDir, docs, scannerOptions);
  if (shouldSyncAssets) {
    await scanAllAssets(markdownDir, assets);
  } else {
    console.log("Asset sync disabled because no Markdown files are selected.");
  }

  await syncAll(serverUrl, docs, assets, shouldSyncAssets);

  console.log("");
  console.log("Markdown sync agent is running.");
  console.log(`Markdown folder: ${markdownDir}`);
  console.log(`Server URL:       ${serverUrl}`);
  console.log(`Sync selection:   ${formatSelection(state.selectedPaths)}`);
  console.log("");
  console.log("Keep this CLI open to sync local changes. Press Ctrl+C to stop.");

  watchMarkdownDir(markdownDir, docs, {
    ...scannerOptions,
    assets: shouldSyncAssets ? assets : undefined,
    onDelete: async (relativePath) => {
      await deleteRemotePaths(serverUrl, [relativePath]);
      console.log(`Synced delete: ${relativePath}`);
    },
    onChange: async (relativePath) => {
      const doc = docs.get(relativePath);
      if (!doc) return;
      await uploadDoc(serverUrl, doc);
    },
    onAssetChange: async (relativePath) => {
      const asset = assets.get(relativePath);
      if (!asset) return;
      await uploadAsset(serverUrl, asset);
    },
    onAssetDelete: async (relativePath) => {
      await deleteRemotePaths(serverUrl, [relativePath]);
      console.log(`Synced asset delete: ${relativePath}`);
    },
  });
}

async function resolveMarkdownDir(inputDir?: string) {
  const defaultDir = await resolveDesktopDir();
  const dir = inputDir?.trim() || await promptOptionalPath(
    `请输入要监听的 Markdown 根目录（直接回车使用桌面：${defaultDir}）: `,
    defaultDir,
  );

  const resolved = path.resolve(dir.replace(/^"|"$/g, ""));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
}

async function resolveServerUrl(inputUrl?: string, savedUrl?: string) {
  const defaultUrl = savedUrl || "http://localhost:50001";
  const answer = inputUrl?.trim() || await promptOptionalPath(
    `请输入服务器地址（直接回车使用：${defaultUrl}）: `,
    defaultUrl,
  );
  return normalizeServerUrl(answer);
}

function normalizeServerUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/g, "");
  if (!/^https?:\/\//i.test(trimmed)) return `http://${trimmed}`;
  return trimmed;
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

async function promptOptionalPath(question: string, defaultValue = "") {
  const rl = createInterface({ input, output });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim() || defaultValue;
}

function parseArgs(args: string[]) {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dir" && args[i + 1]) result.dir = args[++i];
    if (arg === "--server" && args[i + 1]) result.server = args[++i];
    if (arg === "--sync" && args[i + 1]) result.sync = args[++i];
  }
  return result;
}

async function chooseSelectedPaths(markdownDir: string, currentSelection: string[], syncArg?: string) {
  if (syncArg === "all") return ["*"];
  if (syncArg) return syncArg.split(",").map((item) => item.trim()).filter(Boolean);

  const markdownFiles = await listMarkdownFiles(markdownDir);
  if (markdownFiles.length === 0) return [];

  const choices = buildSelectionChoices(markdownFiles);
  console.log("");
  console.log("本地根目录内容：");
  choices.forEach((choice, index) => {
    console.log(`${index + 1}. [${choice.type === "folder" ? "目录" : "文件"}] ${choice.path}`);
  });

  const rl = createInterface({ input, output });
  const answer = await rl.question(
    "是否同步本地文件到服务器？直接回车同步全部；输入编号/区间选择部分（如 1,3 或 1-10）；输入 0 跳过: ",
  );
  rl.close();

  const trimmed = answer.trim();
  if (trimmed === "0" || /^none$/i.test(trimmed)) return [];
  if (!trimmed || /^all$/i.test(trimmed)) return ["*"];

  return selectChoicePaths(choices, trimmed);
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

function selectChoicePaths(choices: RemoteChoice[], inputValue: string) {
  const selectedIndexes = parseSelectionIndexes(inputValue, choices.length);
  return selectedIndexes.map((index) => choices[index - 1].path);
}

function formatSelection(selectedPaths: string[]) {
  if (selectedPaths.includes("*")) return "全部 Markdown 文件";
  return selectedPaths.length > 0 ? selectedPaths.join(", ") : "未选择";
}

async function assertServerReachable(serverUrl: string) {
  const response = await fetch(`${serverUrl}/api/health`);
  if (!response.ok) {
    throw new Error(`Server is not reachable: ${serverUrl}`);
  }
}

async function pullServerFiles(markdownDir: string, serverUrl: string) {
  const files = await fetchJson<RemoteFile[]>(`${serverUrl}/api/files`);
  if (files.length === 0) {
    console.log("Server has no Markdown files to pull.");
    return;
  }

  const choices = buildRemoteRootChoices(files);
  console.log("");
  console.log("服务器根目录内容：");
  choices.forEach((choice, index) => {
    console.log(`${index + 1}. [${choice.type === "folder" ? "目录" : "文件"}] ${choice.path}`);
  });

  const rl = createInterface({ input, output });
  const answer = await rl.question(
    "是否先同步服务器文件到本地？直接回车同步全部；输入编号/区间选择部分（如 1,3 或 1-10）；输入 0 跳过: ",
  );
  rl.close();

  const trimmed = answer.trim();
  if (trimmed === "0" || /^n(o)?$/i.test(trimmed)) {
    console.log("Skipped pulling files from server.");
    return;
  }

  const selectedFiles = trimmed ? selectRemoteFiles(files, choices, trimmed) : files;

  if (selectedFiles.length === 0) {
    console.log("No server files selected to pull.");
    return;
  }

  console.log(`Pulling ${selectedFiles.length} Markdown file(s) from server...`);
  for (const file of selectedFiles) {
    await downloadRemoteFile(markdownDir, `${serverUrl}/md-file?path=${encodeURIComponent(file.relativePath)}`, file.relativePath);
    console.log(`Pulled Markdown: ${file.relativePath}`);
  }

  const assets = await fetchJson<RemoteAsset[]>(`${serverUrl}/api/assets`);
  if (assets.length > 0) {
    console.log(`Pulling ${assets.length} asset file(s) from server...`);
    for (const asset of assets) {
      await downloadRemoteFile(markdownDir, `${serverUrl}/asset?path=${encodeURIComponent(asset.relativePath)}`, asset.relativePath);
      console.log(`Pulled asset: ${asset.relativePath}`);
    }
  }
}

function selectRemoteFiles(files: RemoteFile[], choices: RemoteChoice[], inputValue: string) {
  const selectedIndexes = parseSelectionIndexes(inputValue, choices.length);
  const selectedChoices = selectedIndexes.map((index) => choices[index - 1]);
  return files.filter((file) => {
    return selectedChoices.some((choice) => {
      if (choice.type === "file") return file.relativePath === choice.path;
      return file.relativePath.startsWith(`${choice.path}/`);
    });
  });
}

function buildRemoteRootChoices(files: RemoteFile[]): RemoteChoice[] {
  const folders = new Set<string>();
  const rootFiles = new Set<string>();
  for (const file of files) {
    const [firstSegment, ...rest] = file.relativePath.split("/");
    if (!firstSegment) continue;
    if (rest.length === 0) {
      rootFiles.add(firstSegment);
    } else {
      folders.add(firstSegment);
    }
  }

  return [
    ...[...folders].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")).map((item) => ({
      type: "folder" as const,
      path: item,
    })),
    ...[...rootFiles].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")).map((item) => ({
      type: "file" as const,
      path: item,
    })),
  ];
}

function parseSelectionIndexes(value: string, max: number) {
  const indexes = new Set<number>();
  const tokens = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (tokens.length === 0) throw new Error("No selection provided.");

  for (const token of tokens) {
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start > end) throw new Error(`Invalid range: ${token}`);
      if (start < 1 || end > max) throw new Error(`Range out of bounds: ${token}`);
      for (let index = start; index <= end; index += 1) {
        if (indexes.has(index)) throw new Error(`Duplicate selection: ${index}`);
        indexes.add(index);
      }
      continue;
    }

    const index = Number(token);
    if (!Number.isInteger(index)) throw new Error(`Invalid selection: ${token}`);
    if (index < 1 || index > max) throw new Error(`Selection out of bounds: ${token}`);
    if (indexes.has(index)) throw new Error(`Duplicate selection: ${index}`);
    indexes.add(index);
  }

  return [...indexes].sort((a, b) => a - b);
}

async function downloadRemoteFile(root: string, url: string, relativePath: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${relativePath}: ${await response.text()}`);

  const targetPath = path.resolve(root, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${url}. ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function syncAll(serverUrl: string, docs: Map<string, DocMeta>, assets: Map<string, AssetMeta>, shouldSyncAssets: boolean) {
  console.log(`Initial sync: ${docs.size} Markdown file(s).`);
  for (const doc of docs.values()) {
    await uploadDoc(serverUrl, doc);
  }

  if (!shouldSyncAssets) return;
  console.log(`Initial asset sync: ${assets.size} asset file(s).`);
  for (const asset of assets.values()) {
    await uploadAsset(serverUrl, asset);
  }
}

async function uploadDoc(serverUrl: string, doc: DocMeta) {
  await uploadFile(serverUrl, doc.relativePath, doc.absolutePath);
  console.log(`Synced Markdown: ${doc.relativePath}`);
}

async function uploadAsset(serverUrl: string, asset: AssetMeta) {
  await uploadFile(serverUrl, asset.relativePath, asset.absolutePath);
  console.log(`Synced asset: ${asset.relativePath}`);
}

async function uploadFile(serverUrl: string, relativePath: string, absolutePath: string) {
  const content = await fs.readFile(absolutePath);
  const response = await fetch(`${serverUrl}/api/sync/file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: relativePath,
      contentBase64: content.toString("base64"),
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to sync ${relativePath}: ${await response.text()}`);
  }
}

async function deleteRemotePaths(serverUrl: string, paths: string[]) {
  const response = await fetch(`${serverUrl}/api/sync/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });

  if (!response.ok) {
    throw new Error(`Failed to delete remote path: ${await response.text()}`);
  }
}
