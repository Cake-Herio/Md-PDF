export type DocMeta = {
  relativePath: string;
  absolutePath: string;
  title: string;
  size: number;
  mtimeMs: number;
  hash: string;
};

export type DocStore = Map<string, DocMeta>;

export type DeletionRecord = {
  id: string;
  relativePath: string;
  deletedAt: number;
  source: "mobile" | "local";
  deviceId: string;
};

export type ReaderState = {
  deviceId: string;
  selectedPaths: string[];
  lastSyncedHashByPath: Record<string, string>;
  deletions: DeletionRecord[];
  processedDeletionIds: string[];
};
