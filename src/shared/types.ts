export type DocMeta = {
  relativePath: string;
  absolutePath: string;
  title: string;
  size: number;
  mtimeMs: number;
  hash: string;
};

export type DocStore = Map<string, DocMeta>;

export type AssetMeta = {
  relativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
  hash: string;
};

export type AssetStore = Map<string, AssetMeta>;

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
