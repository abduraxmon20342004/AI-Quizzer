import mammoth from "mammoth";
import type { DocKind } from "./detect.js";
import { buildSections, textQuality, type PageText, type Section } from "./sections.js";

export interface ExtractLimits {
  maxPages: number;
  timeoutMs: number;
  ocr: null | ((images: Uint8Array[]) => Promise<string[]>);
  ocrMaxPages: number;
  renderPdfPages?: (data: Uint8Array, maxPages: number) => Promise<Uint8Array[]>;
}

export type ExtractResult =
  | { ok: true; sections: Section[]; text: string; pageCount: number | null; method: string; quality: number }
  | { ok: false; reason: string };

/** Minimum readable characters per PDF page before we treat the PDF as scanned. */
const MIN_CHARS_PER_PAGE = 40;
const MIN_QUALITY = 0.6;

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pdfPages(data: Uint8Array, maxPages: number): Promise<{ pages: PageText[]; pageCount: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // Text extraction only: pdf.js core does not run JavaScript embedded in PDFs, and fonts are not loaded.
  const task = pdfjs.getDocument({ data: new Uint8Array(data), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    if (doc.numPages > maxPages) throw new Error(`PDF has ${doc.numPages} pages (limit ${maxPages})`);
    const pages: PageText[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let text = "";
      for (const item of tc.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof item.str !== "string") continue;
        text += item.str + (item.hasEOL ? "\n" : " ");
      }
      pages.push({ page: i, text: text.replace(/ {2,}/g, " ") });
      page.cleanup();
    }
    return { pages, pageCount: doc.numPages };
  } finally {
    await task.destroy();
  }
}

export async function extractDocument(kind: DocKind, bytes: Uint8Array, limits: ExtractLimits): Promise<ExtractResult> {
  try {
    return await withTimeout(extractInner(kind, bytes, limits), limits.timeoutMs, "extraction");
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

async function extractInner(kind: DocKind, bytes: Uint8Array, limits: ExtractLimits): Promise<ExtractResult> {
  let pages: PageText[];
  let pageCount: number | null = null;
  let method: string;
  switch (kind) {
    case "txt":
    case "md": {
      const text = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
      pages = [{ page: null, text }];
      method = "plain";
      break;
    }
    case "docx": {
      // mammoth only reads the document XML; macros and embedded objects are never executed.
      const res = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      pages = [{ page: null, text: res.value }];
      method = "docx";
      break;
    }
    case "pdf": {
      const r = await pdfPages(bytes, limits.maxPages);
      pageCount = r.pageCount;
      pages = r.pages;
      method = "pdf_text";
      const chars = pages.reduce((a, p) => a + p.text.trim().length, 0);
      if (chars / Math.max(1, pageCount) < MIN_CHARS_PER_PAGE) {
        if (!limits.ocr || !limits.renderPdfPages) {
          return { ok: false, reason: "PDF skanerlangan ko'rinadi (matn qatlami yo'q). OCR o'chirilgan — matnli PDF, DOCX yoki matn yuboring." };
        }
        if (pageCount > limits.ocrMaxPages) return { ok: false, reason: `Skanerlangan PDF juda katta (${pageCount} bet, OCR chegarasi ${limits.ocrMaxPages}).` };
        const images = await limits.renderPdfPages(bytes, limits.ocrMaxPages);
        const texts = await limits.ocr(images);
        pages = texts.map((text, i) => ({ page: i + 1, text }));
        method = "ocr";
      }
      break;
    }
    case "image": {
      if (!limits.ocr) return { ok: false, reason: "Rasm ichidagi matnni o'qish (OCR) o'chirilgan." };
      const [text] = await limits.ocr([bytes]);
      pages = [{ page: null, text: text ?? "" }];
      method = "ocr";
      break;
    }
  }
  const text = pages.map((p) => p.text).join("\n\n").trim();
  const quality = textQuality(text);
  if (text.length < 80) return { ok: false, reason: "Hujjatdan deyarli matn olinmadi. Boshqa formatda yuboring." };
  if (quality < MIN_QUALITY) return { ok: false, reason: `Matn sifati past (${Math.round(quality * 100)}%). Hujjat buzilgan yoki skanerlangan bo'lishi mumkin.` };
  const sections = buildSections(pages, kind === "md");
  if (!sections.length) return { ok: false, reason: "Matn bo'limlarga ajratilmadi." };
  return { ok: true, sections, text, pageCount, method, quality };
}
