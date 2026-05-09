import type { AssetStore, DocStore } from "../shared/types.js";
import { ensurePdf } from "./pdf.js";

type PdfWarmupOptions = {
  assets: AssetStore;
  cacheDir: string;
  docs: DocStore;
  markdownDir: string;
  themeCssPath?: string;
};

export function createPdfWarmup({
  assets,
  cacheDir,
  docs,
  markdownDir,
  themeCssPath,
}: PdfWarmupOptions) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let rerunRequested = false;
  const pendingPaths = new Set<string>();

  function scheduleAll(reason: string) {
    for (const doc of docs.values()) {
      pendingPaths.add(doc.relativePath);
    }
    schedule(reason);
  }

  function scheduleOne(relativePath: string, reason: string) {
    pendingPaths.add(relativePath);
    schedule(reason);
  }

  function schedule(reason: string) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run(reason);
    }, 1200);
  }

  async function run(reason: string) {
    if (running) {
      rerunRequested = true;
      return;
    }

    const paths = [...pendingPaths];
    pendingPaths.clear();
    if (paths.length === 0) return;

    running = true;
    console.log(`PDF warmup started (${reason}): ${paths.length} file(s).`);
    try {
      for (const relativePath of paths) {
        const doc = docs.get(relativePath);
        if (!doc) continue;

        try {
          await ensurePdf(doc, cacheDir, {
            assets,
            markdownDir,
            themeCssPath,
          });
          console.log(`PDF ready: ${relativePath}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`PDF warmup failed: ${relativePath}. ${message}`);
        }
      }
    } finally {
      running = false;
      if (rerunRequested || pendingPaths.size > 0) {
        rerunRequested = false;
        schedule("queued changes");
      } else {
        console.log("PDF warmup finished.");
      }
    }
  }

  return {
    scheduleAll,
    scheduleOne,
  };
}
