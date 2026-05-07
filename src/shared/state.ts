import { randomUUID } from "node:crypto";
import { constants, existsSync, promises as fs } from "node:fs";
import path from "node:path";
import type { DeletionRecord, ReaderState } from "./types.js";
import { isInside, normalizeRelativePath } from "./path.js";

export async function loadReaderState(statePath: string): Promise<ReaderState> {
  const raw = await fs.readFile(statePath, "utf8").catch(() => null);
  if (!raw) return createDefaultState();

  const parsed = JSON.parse(raw) as Partial<ReaderState>;
  return {
    deviceId: typeof parsed.deviceId === "string" ? parsed.deviceId : randomUUID(),
    selectedPaths: Array.isArray(parsed.selectedPaths)
      ? parsed.selectedPaths.map(normalizeRelativePath).filter(Boolean)
      : [],
    lastSyncedHashByPath: parsed.lastSyncedHashByPath ?? {},
    deletions: Array.isArray(parsed.deletions) ? parsed.deletions : [],
    processedDeletionIds: Array.isArray(parsed.processedDeletionIds)
      ? parsed.processedDeletionIds
      : [],
  };
}

export async function saveReaderState(statePath: string, state: ReaderState) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(`${statePath}.tmp`, statePath);
}

export function createDeletionRecord(
  relativePath: string,
  source: DeletionRecord["source"],
  deviceId: string,
): DeletionRecord {
  return {
    id: randomUUID(),
    relativePath: normalizeRelativePath(relativePath),
    deletedAt: Date.now(),
    source,
    deviceId,
  };
}

export function addDeletionRecord(state: ReaderState, deletion: DeletionRecord) {
  const existing = state.deletions.find((item) => item.relativePath === deletion.relativePath);
  if (existing && existing.deletedAt >= deletion.deletedAt) return existing;

  state.deletions = state.deletions.filter((item) => item.relativePath !== deletion.relativePath);
  state.deletions.push(deletion);
  delete state.lastSyncedHashByPath[deletion.relativePath];
  return deletion;
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

export function isDeletedPath(relativePath: string, state: ReaderState) {
  const normalized = normalizeRelativePath(relativePath);
  return state.deletions.some((deletion) => deletion.relativePath === normalized);
}

export async function processPendingDeletions(
  markdownDir: string,
  trashDir: string,
  state: ReaderState,
) {
  const processed = new Set(state.processedDeletionIds);
  let changed = false;

  for (const deletion of state.deletions) {
    if (processed.has(deletion.id)) continue;

    const absolutePath = path.resolve(markdownDir, deletion.relativePath);
    if (!isInside(markdownDir, absolutePath) && absolutePath !== markdownDir) {
      processed.add(deletion.id);
      changed = true;
      continue;
    }

    if (existsSync(absolutePath)) {
      await moveFileToTrash(markdownDir, trashDir, absolutePath, deletion.relativePath);
      console.log(`Moved deleted remote file to trash: ${deletion.relativePath}`);
    }

    processed.add(deletion.id);
    changed = true;
  }

  if (changed) state.processedDeletionIds = [...processed];
  return changed;
}

function createDefaultState(): ReaderState {
  return {
    deviceId: randomUUID(),
    selectedPaths: [],
    lastSyncedHashByPath: {},
    deletions: [],
    processedDeletionIds: [],
  };
}

async function moveFileToTrash(
  markdownDir: string,
  trashDir: string,
  absolutePath: string,
  relativePath: string,
) {
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) return;

  const normalized = normalizeRelativePath(relativePath);
  const targetPath = await uniqueTrashPath(trashDir, normalized);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  try {
    await fs.rename(absolutePath, targetPath);
  } catch {
    await fs.copyFile(absolutePath, targetPath, constants.COPYFILE_EXCL);
    await fs.unlink(absolutePath);
  }

  await removeEmptyParents(markdownDir, path.dirname(absolutePath));
}

async function uniqueTrashPath(trashDir: string, relativePath: string) {
  const parsed = path.parse(relativePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let candidate = path.join(trashDir, parsed.dir, `${parsed.name}.${stamp}${parsed.ext}`);
  let index = 1;

  while (existsSync(candidate)) {
    candidate = path.join(trashDir, parsed.dir, `${parsed.name}.${stamp}.${index}${parsed.ext}`);
    index += 1;
  }

  return candidate;
}

async function removeEmptyParents(root: string, startDir: string) {
  let current = startDir;
  while (isInside(root, current)) {
    const entries = await fs.readdir(current).catch(() => null);
    if (!entries || entries.length > 0) return;
    await fs.rmdir(current).catch(() => undefined);
    current = path.dirname(current);
  }
}
