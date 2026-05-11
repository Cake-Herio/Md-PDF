import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ReaderState } from "./types.js";
import { normalizeRelativePath } from "./path.js";

export async function loadReaderState(statePath: string): Promise<ReaderState> {
  const raw = await fs.readFile(statePath, "utf8").catch(() => null);
  if (!raw) return createDefaultState();

  const parsed = JSON.parse(raw) as Partial<ReaderState>;
  return {
    deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : randomUUID(),
    serverUrl: typeof parsed.serverUrl === "string" ? parsed.serverUrl : undefined,
    selectedPaths: Array.isArray(parsed.selectedPaths)
      ? parsed.selectedPaths.map(normalizeRelativePath).filter(Boolean)
      : [],
    lastSyncedHashByPath: parsed.lastSyncedHashByPath ?? {},
    pinnedPaths: Array.isArray(parsed.pinnedPaths)
      ? parsed.pinnedPaths.map(normalizeRelativePath).filter(Boolean)
      : [],
  };
}

export async function saveReaderState(statePath: string, state: ReaderState) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(`${statePath}.tmp`, statePath);
}

export function isSelectedPath(relativePath: string, selectedPaths: string[]) {
  const normalized = normalizeRelativePath(relativePath);
  if (selectedPaths.length === 0) return false;
  return selectedPaths.some((selectedPath) => {
    const selected = normalizeRelativePath(selectedPath).replace(/\/+$/g, "");
    if (selected === "*") return true;
    return normalized === selected || normalized.startsWith(`${selected}/`);
  });
}

export function setPinnedPath(state: ReaderState, relativePath: string, pinned: boolean) {
  const normalized = normalizeRelativePath(relativePath).replace(/\/+$/g, "");
  if (!normalized) return false;

  const oldLength = state.pinnedPaths.length;
  state.pinnedPaths = state.pinnedPaths.filter((item) => item !== normalized);
  if (pinned) state.pinnedPaths.push(normalized);
  return oldLength !== state.pinnedPaths.length || pinned;
}

export function isPinnedPath(relativePath: string, state: ReaderState) {
  const normalized = normalizeRelativePath(relativePath).replace(/\/+$/g, "");
  return state.pinnedPaths.includes(normalized);
}

function createDefaultState(): ReaderState {
  return {
    deviceId: randomUUID(),
    serverUrl: undefined,
    selectedPaths: [],
    lastSyncedHashByPath: {},
    pinnedPaths: [],
  };
}
