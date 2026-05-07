import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fs } from "node:fs";
import { createDocStore, scanAll } from "../shared/doc-store.js";
import { loadReaderState, saveReaderState } from "../shared/state.js";
import { createApp } from "./app.js";

const appRoot = process.cwd();
const stateDir = path.join(appRoot, ".md-pdf-server");
const cacheDir = path.join(stateDir, "pdf-cache");
const statePath = path.join(stateDir, "state.json");

async function startServer() {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port ?? 3000);
  const markdownDir = await resolveMarkdownDir(args.dir);
  const themeCssPath = await resolveOptionalFile(args.themeCss ?? process.env.TYPORA_THEME_CSS);
  const docs = createDocStore();
  const state = await loadReaderState(statePath);

  await fs.mkdir(cacheDir, { recursive: true });
  await scanAll(markdownDir, docs);
  await saveReaderState(statePath, state);

  const app = createApp({
    markdownDir,
    cacheDir,
    docs,
    themeCssPath,
    state,
    saveState: () => saveReaderState(statePath, state),
  });
  const server = createServer(app);

  server.listen(port, "0.0.0.0", () => {
    console.log("");
    console.log(`Server storage:  ${markdownDir}`);
    if (themeCssPath) console.log(`Typora theme CSS: ${themeCssPath}`);
    console.log(`Local address:   http://localhost:${port}`);
    for (const ip of getLanIPv4()) {
      console.log(`Phone address:   http://${ip}:${port}`);
    }
    console.log("");
    console.log("Server is running. Press Ctrl+C to stop.");
  });
}

async function resolveMarkdownDir(inputDir?: string) {
  let dir = inputDir?.trim();
  if (!dir) {
    const rl = createInterface({ input, output });
    dir = await rl.question("请输入服务器 Markdown 存储目录: ");
    rl.close();
  }

  const resolved = path.resolve(dir.replace(/^"|"$/g, ""));
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return resolved;
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
  process.exit(1);
});
