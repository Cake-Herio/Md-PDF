const search = document.querySelector("#search");
const items = [...document.querySelectorAll(".browse-item")];
const selectModeButton = document.querySelector("#select-mode-button");
const deleteSelectedButton = document.querySelector("#delete-selected-button");
const cancelSelectButton = document.querySelector("#cancel-select-button");
const fileSelects = [...document.querySelectorAll(".file-select")];
const pinButtons = [...document.querySelectorAll(".item-pin-action")];
const deleteButtons = [...document.querySelectorAll(".item-delete-action")];

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
    "确认删除选中的 " + paths.length + " 个服务器文件和 PDF 缓存？",
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

async function deletePath(path, kind) {
  const confirmed = window.confirm(
    kind === "folder"
      ? "确认删除该文件夹下所有服务器 Markdown 和 PDF 缓存？"
      : "确认删除该服务器 Markdown 和 PDF 缓存？",
  );
  if (!confirmed) return;

  const response = await fetch("/api/files/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: [path] }),
  });
  if (!response.ok) throw new Error(await response.text());
  window.location.reload();
}

async function setPinned(path, pinned) {
  const response = await fetch("/api/files/pin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, pinned }),
  });
  if (!response.ok) throw new Error(await response.text());
  window.location.reload();
}

for (const button of pinButtons) {
  button.addEventListener("click", async () => {
    const item = button.closest(".browse-item");
    if (!item || item.dataset.kind !== "file") return;
    try {
      await setPinned(item.dataset.path, item.dataset.pinned !== "true");
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  });
}

for (const button of deleteButtons) {
  button.addEventListener("click", async () => {
    const item = button.closest(".browse-item");
    if (!item) return;
    try {
      await deletePath(item.dataset.path, item.dataset.kind);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error));
    }
  });
}

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
    event.stopPropagation();
    startPdf(link.dataset.pdfPath, link.dataset.pdfTitle);
  });

  link.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    startPdf(link.dataset.pdfPath, link.dataset.pdfTitle);
  });
}

closeButton.addEventListener("click", closeModal);
window.addEventListener("pageshow", closeModal);
