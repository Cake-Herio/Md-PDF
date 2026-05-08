import path from "node:path";

export const ASSET_DIR = "asset";

const imageAssetExtensions = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
]);

export function shouldIgnore(filePath: string, root: string) {
  const relative = toRelative(root, filePath);
  const segments = relative.split("/");
  return segments.some((segment) => {
    return (
      segment === "node_modules" ||
      segment === ".git" ||
      segment === ".md-local-reader" ||
      segment.startsWith(".") ||
      segment.endsWith(".tmp") ||
      segment.endsWith(".swp") ||
      segment.startsWith("~$")
    );
  });
}

export function isMarkdown(filePath: string) {
  return /\.md$/i.test(filePath);
}

export function isImageAsset(filePath: string) {
  return imageAssetExtensions.has(path.extname(filePath).toLowerCase());
}

export function isAssetPath(relativePath: string) {
  const normalized = normalizeRelativePath(relativePath);
  return normalized === ASSET_DIR || normalized.startsWith(`${ASSET_DIR}/`);
}

export function toRelative(root: string, filePath: string) {
  return normalizeRelativePath(path.relative(root, filePath));
}

export function normalizeRelativePath(value: string) {
  return value.replaceAll("\\", "/").replace(/^\/+/, "");
}

export function isInside(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
