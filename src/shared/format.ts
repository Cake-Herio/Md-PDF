export function buildContentDisposition(
  disposition: "inline" | "attachment",
  filename: string,
) {
  const asciiName = sanitizeFilename(filename);
  const encodedName = encodeURIComponent(filename);
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

export function sanitizeFilename(filename: string) {
  return filename
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[^\x20-\x7E]/g, "_")
    .slice(0, 120);
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
