import { marked } from "marked";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DocMeta } from "../shared/types.js";
import { escapeHtml, formatBytes } from "../shared/format.js";

type MarkdownRenderOptions = {
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

marked.setOptions({
  gfm: true,
  breaks: false,
});

export function renderIndexHtml(view: DirectoryView) {
  const folderItems = view.folders
    .map((folder) => {
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
    })
    .join("");

  const fileItems = view.files
    .map((doc) => {
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
    })
    .join("");
  const items = folderItems + fileItems;
  const currentLabel = view.currentDir || "根目录";
  const parentLink = view.parentDir === null
    ? ""
    : `<a class="back-link" href="/${view.parentDir ? `?dir=${encodeURIComponent(view.parentDir)}` : ""}">返回上级</a>`;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Markdown PDF Reader</title>
  ${styleTag()}
</head>
<body>
  <main class="shell">
    <header class="hero">
      <h1>Markdown PDF Reader</h1>
      <p>当前位于 ${escapeHtml(currentLabel)}，共 ${view.folders.length} 个文件夹、${view.files.length} 个 Markdown 文件。</p>
      <div class="breadcrumbs">
        ${parentLink}
        <span class="current-dir">${escapeHtml(currentLabel)}</span>
      </div>
      <div class="bulk-actions">
        <button id="select-mode-button" type="button">选择文件</button>
        <button id="delete-selected-button" type="button" hidden>删除选中</button>
        <button id="cancel-select-button" type="button" hidden>取消</button>
      </div>
      <input id="search" type="search" placeholder="搜索文件名或路径" autocomplete="off" />
    </header>
    <ul id="docs" class="doc-list">${items || `<li class="empty">当前目录下没有 Markdown 文件。</li>`}</ul>
  </main>
  <div id="pdf-modal" class="modal-backdrop" hidden>
    <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="pdf-modal-title">
      <button id="pdf-modal-close" class="modal-close" type="button" aria-label="关闭">×</button>
      <div class="progress-ring" aria-hidden="true">
        <svg viewBox="0 0 128 128">
          <circle class="progress-ring-bg" cx="64" cy="64" r="54"></circle>
          <circle id="pdf-progress-circle" class="progress-ring-value" cx="64" cy="64" r="54"></circle>
        </svg>
        <div id="pdf-progress-percent" class="progress-percent">0%</div>
      </div>
      <h2 id="pdf-modal-title">正在生成 PDF</h2>
      <p id="pdf-modal-file" class="modal-file"></p>
      <p id="pdf-modal-status" class="modal-status">正在准备...</p>
    </section>
  </div>
  <script>
    const search = document.querySelector("#search");
    const items = [...document.querySelectorAll(".browse-item")];
    const selectModeButton = document.querySelector("#select-mode-button");
    const deleteSelectedButton = document.querySelector("#delete-selected-button");
    const cancelSelectButton = document.querySelector("#cancel-select-button");
    const fileSelects = [...document.querySelectorAll(".file-select")];
    search?.addEventListener("input", () => {
      const keyword = search.value.trim().toLowerCase();
      for (const item of items) {
        item.hidden = !item.dataset.text.toLowerCase().includes(keyword);
      }
    });

    function selectedPaths() {
      return fileSelects.filter((item) => item.checked).map((item) => item.value);
    }

    function updateDeleteButton() {
      deleteSelectedButton.textContent = "删除选中 (" + selectedPaths().length + ")";
    }

    function setSelectMode(enabled) {
      document.body.classList.toggle("select-mode", enabled);
      selectModeButton.hidden = enabled;
      deleteSelectedButton.hidden = !enabled;
      cancelSelectButton.hidden = !enabled;
      if (!enabled) {
        for (const item of fileSelects) item.checked = false;
      }
      updateDeleteButton();
    }

    selectModeButton.addEventListener("click", () => setSelectMode(true));
    cancelSelectButton.addEventListener("click", () => setSelectMode(false));
    for (const item of fileSelects) item.addEventListener("change", updateDeleteButton);

    deleteSelectedButton.addEventListener("click", async () => {
      const paths = selectedPaths();
      if (paths.length === 0) return;
      const confirmed = window.confirm(
        "确认删除选中的 " + paths.length + " 个服务器文件？其他电脑下次启动同步程序时，本地同路径文件会移入回收站。",
      );
      if (!confirmed) return;

      deleteSelectedButton.disabled = true;
      try {
        const response = await fetch("/api/files/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths }),
        });
        if (!response.ok) throw new Error(await response.text());
        window.location.reload();
      } catch (error) {
        window.alert(error instanceof Error ? error.message : String(error));
      } finally {
        deleteSelectedButton.disabled = false;
      }
    });

    const modal = document.querySelector("#pdf-modal");
    const closeButton = document.querySelector("#pdf-modal-close");
    const fileLabel = document.querySelector("#pdf-modal-file");
    const statusLabel = document.querySelector("#pdf-modal-status");
    const percentLabel = document.querySelector("#pdf-progress-percent");
    const progressCircle = document.querySelector("#pdf-progress-circle");
    const circumference = 2 * Math.PI * 54;
    let pollTimer = null;

    progressCircle.style.strokeDasharray = circumference;
    progressCircle.style.strokeDashoffset = circumference;

    function setProgress(progress) {
      const normalized = Math.max(0, Math.min(100, Number(progress) || 0));
      progressCircle.style.strokeDashoffset = circumference * (1 - normalized / 100);
      percentLabel.textContent = Math.round(normalized) + "%";
    }

    function openModal(title) {
      if (pollTimer) window.clearTimeout(pollTimer);
      fileLabel.textContent = title;
      statusLabel.textContent = "正在准备生成 PDF...";
      setProgress(10);
      modal.hidden = false;
    }

    function closeModal() {
      if (pollTimer) window.clearTimeout(pollTimer);
      pollTimer = null;
      modal.hidden = true;
    }

    function navigateToPdf(pdfUrl, delay) {
      if (pollTimer) window.clearTimeout(pollTimer);
      pollTimer = null;
      window.setTimeout(() => {
        closeModal();
        window.location.href = pdfUrl;
      }, delay);
    }

    async function pollPdfJob(jobId) {
      const response = await fetch("/api/pdf-jobs/" + encodeURIComponent(jobId));
      if (!response.ok) throw new Error("无法获取 PDF 生成状态。");

      const job = await response.json();
      statusLabel.textContent = job.error || job.message || "正在生成 PDF...";
      setProgress(job.progress);

      if (job.status === "done") {
        setProgress(100);
        statusLabel.textContent = "生成完成，即将打开。";
        navigateToPdf(job.pdfUrl, 450);
        return;
      }

      if (job.status === "error") return;
      pollTimer = window.setTimeout(() => pollPdfJob(jobId).catch(showPdfError), 500);
    }

    function showPdfError(error) {
      statusLabel.textContent = error instanceof Error ? error.message : String(error);
      setProgress(100);
    }

    async function startPdf(path, title) {
      openModal(title || path);
      try {
        const response = await fetch("/api/pdf-jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        if (!response.ok) throw new Error(await response.text());

        const job = await response.json();
        statusLabel.textContent = job.message || "正在生成 PDF...";
        setProgress(job.progress);

        if (job.status === "done") {
          navigateToPdf(job.pdfUrl, 300);
        } else {
          pollTimer = window.setTimeout(() => pollPdfJob(job.jobId).catch(showPdfError), 500);
        }
      } catch (error) {
        showPdfError(error);
      }
    }

    for (const link of document.querySelectorAll(".pdf-action")) {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        startPdf(link.dataset.pdfPath, link.dataset.pdfTitle);
      });
    }

    closeButton.addEventListener("click", closeModal);
    window.addEventListener("pageshow", closeModal);
  </script>
</body>
</html>`;
}

export function renderMarkdownHtml(
  doc: DocMeta,
  markdown: string,
  forPdf: boolean,
  options: MarkdownRenderOptions = {},
) {
  const baseHref = pathToFileURL(path.dirname(doc.absolutePath) + path.sep).href;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <base href="${baseHref}" />
  <title>${escapeHtml(doc.title)}</title>
  ${styleTag(options.themeCss)}
</head>
<body class="${forPdf ? "pdf typora-export" : "typora-export"}">
  <article id="write" class="markdown-body typora-export">
    ${marked.parse(markdown)}
  </article>
</body>
</html>`;
}

function styleTag(themeCss?: string) {
  return `<style>
    :root {
      color-scheme: light;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f6f7f9;
      color: #1f2328;
    }
    body {
      margin: 0;
      background: #f6f7f9;
    }
    .shell {
      max-width: 880px;
      margin: 0 auto;
      padding: 24px 14px 48px;
    }
    .hero {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 18px;
      padding: 20px;
      box-shadow: 0 8px 30px rgba(15, 23, 42, 0.06);
    }
    h1 {
      margin: 0 0 8px;
      font-size: 26px;
    }
    .hero p {
      margin: 0 0 16px;
      color: #5f6b7a;
      line-height: 1.6;
    }
    .breadcrumbs {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 14px;
      color: #667085;
      font-size: 14px;
    }
    .back-link {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      border: 1px solid #d0d7de;
      border-radius: 999px;
      padding: 0 11px;
      color: #0969da;
      background: #f6f8fa;
      font-weight: 600;
      text-decoration: none;
    }
    .current-dir {
      word-break: break-all;
    }
    .bulk-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 14px;
    }
    .bulk-actions button {
      min-height: 34px;
      border: 1px solid #d0d7de;
      border-radius: 999px;
      padding: 0 13px;
      color: #0969da;
      background: #f6f8fa;
      font-size: 14px;
      font-weight: 700;
    }
    #delete-selected-button {
      color: #cf222e;
      border-color: #ffebe9;
      background: #ffebe9;
    }
    #delete-selected-button:disabled {
      opacity: 0.6;
    }
    input[type="search"] {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #d0d7de;
      border-radius: 12px;
      padding: 13px 14px;
      font-size: 16px;
      outline: none;
    }
    .doc-list {
      list-style: none;
      margin: 14px 0 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    .doc-item, .folder-item, .empty {
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      padding: 16px;
    }
    .select-row {
      display: none;
      align-items: center;
      gap: 8px;
      margin: 0 0 10px;
      color: #475467;
      font-size: 14px;
      font-weight: 700;
    }
    .select-row input {
      width: 20px;
      height: 20px;
    }
    .select-mode .select-row {
      display: inline-flex;
    }
    .folder-item {
      padding: 0;
    }
    .folder-link {
      display: flex;
      align-items: center;
      gap: 12px;
      min-height: 64px;
      padding: 14px 16px;
      color: inherit;
      text-decoration: none;
    }
    .folder-icon {
      display: inline-grid;
      place-items: center;
      width: 42px;
      height: 42px;
      border-radius: 12px;
      background: #fff8c5;
      color: #7d4e00;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.04em;
      flex: 0 0 auto;
    }
    .folder-main {
      display: grid;
      gap: 4px;
      min-width: 0;
      flex: 1;
    }
    .folder-name {
      color: #24292f;
      font-size: 17px;
      font-weight: 700;
      word-break: break-all;
    }
    .folder-meta {
      color: #667085;
      font-size: 13px;
    }
    .folder-arrow {
      color: #8c959f;
      font-weight: 800;
      flex: 0 0 auto;
    }
    .title {
      display: block;
      color: #0969da;
      font-size: 18px;
      font-weight: 700;
      text-decoration: none;
      line-height: 1.45;
    }
    .path, .meta {
      margin-top: 6px;
      color: #667085;
      font-size: 13px;
      word-break: break-all;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 12px;
    }
    .actions a {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      border: 1px solid #d0d7de;
      border-radius: 999px;
      padding: 0 13px;
      color: #0969da;
      background: #f6f8fa;
      font-size: 14px;
      font-weight: 600;
      text-decoration: none;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: grid;
      place-items: center;
      padding: 20px;
      background: rgba(15, 23, 42, 0.42);
      backdrop-filter: blur(4px);
    }
    .modal-backdrop[hidden] {
      display: none;
    }
    .modal-card {
      position: relative;
      box-sizing: border-box;
      width: min(360px, 100%);
      border: 1px solid #e5e7eb;
      border-radius: 22px;
      padding: 28px 22px 24px;
      background: #fff;
      box-shadow: 0 24px 80px rgba(15, 23, 42, 0.28);
      text-align: center;
    }
    .modal-close {
      position: absolute;
      top: 12px;
      right: 12px;
      width: 34px;
      height: 34px;
      border: 0;
      border-radius: 999px;
      background: #f3f4f6;
      color: #475467;
      font-size: 22px;
      line-height: 1;
    }
    .progress-ring {
      position: relative;
      width: 128px;
      height: 128px;
      margin: 8px auto 18px;
    }
    .progress-ring svg {
      width: 128px;
      height: 128px;
      transform: rotate(-90deg);
    }
    .progress-ring circle {
      fill: none;
      stroke-width: 10;
    }
    .progress-ring-bg {
      stroke: #e5e7eb;
    }
    .progress-ring-value {
      stroke: #0969da;
      stroke-linecap: round;
      transition: stroke-dashoffset 420ms ease;
    }
    .progress-percent {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      color: #0969da;
      font-size: 24px;
      font-weight: 800;
    }
    .modal-card h2 {
      margin: 0 0 8px;
      font-size: 21px;
    }
    .modal-file {
      margin: 0;
      color: #475467;
      font-size: 14px;
      word-break: break-all;
    }
    .modal-status {
      margin: 12px 0 0;
      color: #667085;
      line-height: 1.5;
    }
    .markdown-body {
      box-sizing: border-box;
      max-width: 820px;
      margin: 0 auto;
      padding: 42px 24px 70px;
      background: #fff;
      color: #24292f;
      line-height: 1.75;
      font-size: 16px;
    }
    .markdown-body h1, .markdown-body h2, .markdown-body h3 {
      line-height: 1.3;
      margin-top: 1.6em;
    }
    .markdown-body h1 {
      font-size: 30px;
      border-bottom: 1px solid #d8dee4;
      padding-bottom: 0.3em;
    }
    .markdown-body h2 {
      font-size: 24px;
      border-bottom: 1px solid #d8dee4;
      padding-bottom: 0.25em;
    }
    .markdown-body img {
      max-width: 100%;
    }
    .markdown-body code {
      background: #f6f8fa;
      border-radius: 6px;
      padding: 0.15em 0.35em;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 0.92em;
    }
    .markdown-body pre {
      overflow: auto;
      background: #f6f8fa;
      border-radius: 10px;
      padding: 16px;
      line-height: 1.55;
    }
    .markdown-body pre code {
      padding: 0;
      background: transparent;
    }
    .markdown-body blockquote {
      margin: 1em 0;
      padding: 0 1em;
      color: #57606a;
      border-left: 0.25em solid #d0d7de;
    }
    .markdown-body table {
      display: block;
      width: 100%;
      overflow: auto;
      border-collapse: collapse;
    }
    .markdown-body th, .markdown-body td {
      border: 1px solid #d0d7de;
      padding: 6px 10px;
    }
    ${themeCss ? sanitizeCssForStyle(themeCss) : ""}
    .pdf .markdown-body {
      max-width: none;
      padding: 0;
      font-size: 15px;
    }
    @page {
      size: A4;
      margin: 18mm 16mm;
    }
    @media (max-width: 640px) {
      .shell {
        padding: 12px 10px 32px;
      }
      .hero {
        padding: 16px;
        border-radius: 14px;
      }
      h1 {
        font-size: 22px;
      }
      .markdown-body {
        padding: 24px 16px 48px;
        font-size: 16px;
      }
    }
  </style>`;
}

function sanitizeCssForStyle(css: string) {
  return css.replace(/<\/style/gi, "<\\/style");
}
