import path from "node:path";
import { withTimeout } from "./extract.js";

/**
 * Bounded OCR with tesseract.js (WebAssembly, no system binaries). Language data is downloaded once from
 * the tesseract.js CDN into .data/tessdata unless OCR_LANG_PATH points to local *.traineddata files.
 * Enabled only with OCR_ENABLED=true.
 */
export function createOcr(opts: { langs: string; langPath?: string; timeoutMs: number }) {
  return async (images: Uint8Array[]): Promise<string[]> => {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker(opts.langs.split("+"), 1, {
      cachePath: path.resolve(".data/tessdata"),
      ...(opts.langPath ? { langPath: opts.langPath } : {}),
    });
    try {
      const out: string[] = [];
      for (const img of images) {
        const res = await withTimeout(worker.recognize(Buffer.from(img)), opts.timeoutMs, "OCR");
        out.push(res.data.text ?? "");
      }
      return out;
    } finally {
      await worker.terminate();
    }
  };
}

/** Render PDF pages to PNG (for OCR of scanned PDFs) using pdfjs + @napi-rs/canvas. */
export async function renderPdfPages(data: Uint8Array, maxPages: number): Promise<Uint8Array[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createCanvas } = await import("@napi-rs/canvas");
  const task = pdfjs.getDocument({ data: new Uint8Array(data), verbosity: 0 });
  const doc = await task.promise;
  try {
    const out: Uint8Array[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
      out.push(await canvas.encode("png"));
      page.cleanup();
    }
    return out;
  } finally {
    await task.destroy();
  }
}
