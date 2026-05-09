import { createServer } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fs } from "node:fs";
import { createAssetStore, createDocStore, scanAll, scanAllAssets } from "../shared/doc-store.js";
import { loadReaderState, saveReaderState } from "../shared/state.js";
import { createApp } from "./app.js";
import { createPdfWarmup } from "./pdf-warmup.js";

const appRoot = process.cwd();
const stateDir = path.join(appRoot, ".md-pdf-server");
const cacheDir = path.join(stateDir, "pdf-cache");
const statePath = path.join(stateDir, "state.json");
const defaultPort = 50001;

async function startServer() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port ?? defaultPort);
  const markdownDir = await resolveMarkdownDir(args.dir);
  const themeCssPath = await resolveOptionalFile(args.themeCss ?? process.env.TYPORA_THEME_CSS);
  const docs = createDocStore();
  const assets = createAssetStore();
  const state = await loadReaderState(statePath);

  await fs.mkdir(cacheDir, { recursive: true });
  await scanAll(markdownDir, docs);
  await scanAllAssets(markdownDir, assets);
  await saveReaderState(statePath, state);

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
  const pdfWarmup = createPdfWarmup({
    assets,
    cacheDir,
    docs,
    markdownDir,
    themeCssPath,
  });

  listenOnPort(server, port, () => {
    const localUrl = `http://localhost:${port}`;
    const phoneUrls = getLanIPv4().map((ip) => `http://${ip}:${port}`);
    console.log("");
    console.log(`Server storage:  ${markdownDir}`);
    if (themeCssPath) console.log(`Typora theme CSS: ${themeCssPath}`);
    console.log(`Local address:   ${localUrl}`);
    for (const phoneUrl of phoneUrls) {
      console.log(`Phone address:   ${phoneUrl}`);
    }
    console.log(`Files API:       ${localUrl}/api/files`);
    console.log(`Assets API:      ${localUrl}/api/assets`);
    console.log("");
    console.log("Server is running. Press Ctrl+C to stop.");
  });

}

function listenOnPort(
  server: ReturnType<typeof createServer>,
  port: number,
  onListening: () => void,
) {
  const onError = (error: NodeJS.ErrnoException) => {
    server.off("error", onError);
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Please stop the process using this port, then restart.`);
      process.exitCode = 1;
      return;
    }

    console.error(error);
    process.exitCode = 1;
  };

  server.once("error", onError);
  server.listen(port, "0.0.0.0", () => {
    server.off("error", onError);
    onListening();
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
  }
  return result;
}

function getLanIPv4() {
  return Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
}

startServer().catch((error) => {
  console.error(error);
  waitBeforeExit().finally(() => process.exit(1));
});

async function waitBeforeExit() {
  if (!process.stdin.isTTY) return;
  const rl = createInterface({ input, output });
  await rl.question("程序启动失败。按回车键退出...");
  rl.close();
}
