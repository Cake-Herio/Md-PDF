export type DocMeta = {
  relativePath: string;
  absolutePath: string;
  title: string;
  size: number;
  mtimeMs: number;
  hash: string;
  pinned?: boolean;
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

export type ReaderState = {
  deviceId: string;
  selectedPaths: string[];
  lastSyncedHashByPath: Record<string, string>;
  pinnedPaths: string[];
};
