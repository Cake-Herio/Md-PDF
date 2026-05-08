import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { marked } from "marked";
import { escapeHtml, formatBytes } from "../shared/format.js";
import { isAssetPath, normalizeRelativePath } from "../shared/path.js";
import type { DocMeta } from "../shared/types.js";

type MarkdownRenderOptions = {
  markdownDir?: string;
  themeCss?: string;
};

export type DirectoryEntry = {
  name: string;
  relativePath: string;
  docCount: number;
};

export type DirectoryView = {
  currentDir: string;
  parentDir: string | null;
  folders: DirectoryEntry[];
  files: DocMeta[];
  totalDocs: number;
};

const viewDir = resolveViewDir();
const viewCache = new Map<string, string>();

marked.setOptions({
  gfm: true,
  breaks: false,
});

export function renderIndexHtml(view: DirectoryView) {
  const currentLabel = view.currentDir || "根目录";
  return renderTemplate("index.html", {
    CURRENT_LABEL: escapeHtml(currentLabel),
    FILE_COUNT: String(view.files.length),
    FOLDER_COUNT: String(view.folders.length),
    INDEX_SCRIPT: readView("index-client.js"),
    ITEMS: renderItems(view),
    PARENT_LINK: renderParentLink(view.parentDir),
    STYLE_TAG: styleTag(),
  });
}

export function renderMarkdownHtml(
  doc: DocMeta,
  markdown: string,
  forPdf: boolean,
  options: MarkdownRenderOptions = {},
) {
  const baseHref = pathToFileURL(path.dirname(doc.absolutePath) + path.sep).href;
  const renderedMarkdown = rewriteAssetImageReferences(doc, markdown, forPdf, options);

  return renderTemplate("markdown.html", {
    BASE_HREF: baseHref,
    BODY_CLASS: forPdf ? "pdf typora-export" : "typora-export",
    CONTENT_HTML: String(marked.parse(renderedMarkdown)),
    STYLE_TAG: styleTag(options.themeCss),
    TITLE: escapeHtml(doc.title),
  });
}

function renderItems(view: DirectoryView) {
  const items = view.folders.map(renderFolderItem).join("") + view.files.map(renderFileItem).join("");
  return items || `<li class="empty">当前目录下没有 Markdown 文件。</li>`;
}

function renderFolderItem(folder: DirectoryEntry) {
  const encoded = encodeURIComponent(folder.relativePath);
  return `<li class="browse-item folder-item" data-text="${escapeHtml(`${folder.name} ${folder.relativePath}`)}">
    <a class="folder-link" href="/?dir=${encoded}" aria-label="打开文件夹 ${escapeHtml(folder.name)}">
      <span class="folder-icon" aria-hidden="true">DIR</span>
      <span class="folder-main">
        <span class="folder-name">${escapeHtml(folder.name)}</span>
        <span class="folder-meta">${folder.docCount} 个 Markdown 文件</span>
      </span>
      <span class="folder-arrow" aria-hidden="true">&gt;</span>
    </a>
  </li>`;
}

function renderFileItem(doc: DocMeta) {
  const encoded = encodeURIComponent(doc.relativePath);
  const updated = new Date(doc.mtimeMs).toLocaleString();
  return `<li class="browse-item doc-item" data-path="${escapeHtml(doc.relativePath)}" data-text="${escapeHtml(`${doc.title} ${doc.relativePath}`)}">
    <label class="select-row">
      <input class="file-select" type="checkbox" value="${escapeHtml(doc.relativePath)}" />
      <span>选择</span>
    </label>
    <a class="title pdf-action" href="/pdf?path=${encoded}" data-pdf-path="${escapeHtml(doc.relativePath)}" data-pdf-title="${escapeHtml(doc.title)}">${escapeHtml(doc.title)}</a>
    <div class="path">${escapeHtml(doc.relativePath)}</div>
    <div class="meta">${formatBytes(doc.size)} · ${updated}</div>
    <div class="actions">
      <a class="pdf-action" href="/pdf?path=${encoded}" data-pdf-path="${escapeHtml(doc.relativePath)}" data-pdf-title="${escapeHtml(doc.title)}">打开 PDF</a>
      <a href="/view?path=${encoded}">打开 MD</a>
    </div>
  </li>`;
}

function renderParentLink(parentDir: string | null) {
  if (parentDir === null) return "";
  const href = parentDir ? `/?dir=${encodeURIComponent(parentDir)}` : "/";
  return `<a class="back-link" href="${href}">返回上级</a>`;
}

function renderTemplate(fileName: string, values: Record<string, string>) {
  let html = readView(fileName);
  for (const [key, value] of Object.entries(values)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }
  return html;
}

function styleTag(themeCss?: string) {
  const css = readView("styles.css").replace("{{THEME_CSS}}", themeCss ? sanitizeCssForStyle(themeCss) : "");
  return `<style>\n${css}\n</style>`;
}

function readView(fileName: string) {
  const cached = viewCache.get(fileName);
  if (cached !== undefined) return cached;

  const content = readFileSync(path.join(viewDir, fileName), "utf8");
  viewCache.set(fileName, content);
  return content;
}

function resolveViewDir() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "views"),
    path.join(process.cwd(), "src", "server", "views"),
    path.join(process.cwd(), "dist", "server", "views"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`View templates not found. Tried: ${candidates.join(", ")}`);
  return found;
}

function sanitizeCssForStyle(css: string) {
  return css.replace(/<\/style/gi, "<\\/style");
}

function rewriteAssetImageReferences(
  doc: DocMeta,
  markdown: string,
  forPdf: boolean,
  options: MarkdownRenderOptions,
) {
  return markdown
    .replace(/!\[([^\]]*)\]\(([^)\r\n]+)\)/g, (full, alt: string, target: string) => {
      const rewritten = rewriteMarkdownImageTarget(doc, target, forPdf, options);
      return rewritten ? `![${alt}](${rewritten})` : full;
    })
    .replace(/(<img\b[^>]*?\bsrc=["'])([^"']+)(["'][^>]*>)/gi, (full, before: string, src: string, after: string) => {
      const rewritten = toAssetUrl(doc, src, forPdf, options);
      return rewritten ? `${before}${escapeHtml(rewritten)}${after}` : full;
    });
}

function rewriteMarkdownImageTarget(
  doc: DocMeta,
  target: string,
  forPdf: boolean,
  options: MarkdownRenderOptions,
) {
  const match = target.trim().match(/^(\S+)(.*)$/);
  if (!match) return null;

  const rewritten = toAssetUrl(doc, stripWrappingQuotes(match[1]), forPdf, options);
  if (!rewritten) return null;
  return `${rewritten}${match[2]}`;
}

function toAssetUrl(doc: DocMeta, rawSrc: string, forPdf: boolean, options: MarkdownRenderOptions) {
  const assetPath = resolveAssetPath(doc, rawSrc);
  if (!assetPath) return null;

  if (forPdf && options.markdownDir) {
    return pathToFileURL(path.join(options.markdownDir, assetPath)).href;
  }

  return `/asset?path=${encodeURIComponent(assetPath)}`;
}

function resolveAssetPath(doc: DocMeta, rawSrc: string) {
  const withoutAnchor = rawSrc.split("#", 1)[0] ?? "";
  const withoutQuery = withoutAnchor.split("?", 1)[0] ?? "";
  if (!withoutQuery || isExternalUrl(withoutQuery)) return null;

  const decoded = safeDecodeURIComponent(withoutQuery);
  const normalized = normalizeRelativePath(decoded);
  if (isAssetPath(normalized)) return normalized;

  if (rawSrc.startsWith("/")) {
    const typoraRootAssetPath = normalizeRelativePath(path.posix.join("asset", normalized));
    if (isAssetPath(typoraRootAssetPath)) return typoraRootAssetPath;
  }

  const rootAssetAlias = normalized.replace(/^\.\//, "");
  if (isAssetPath(rootAssetAlias)) return rootAssetAlias;

  const docDir = path.posix.dirname(doc.relativePath);
  const fromDoc = normalizeRelativePath(path.posix.normalize(path.posix.join(docDir, normalized)));
  return isAssetPath(fromDoc) ? fromDoc : null;
}

function isExternalUrl(value: string) {
  return /^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//");
}

function stripWrappingQuotes(value: string) {
  return value.replace(/^["']|["']$/g, "");
}

function safeDecodeURIComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
