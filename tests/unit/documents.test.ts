import { describe, expect, it } from "vitest";
import { detectDocument } from "../../src/documents/detect.js";
import { extractDocument } from "../../src/documents/extract.js";
import { buildSections } from "../../src/documents/sections.js";
import { LESSON_SNIPPET, makeDocx, makePdf } from "../fixtures.js";

const limits = { maxPages: 5, timeoutMs: 20_000, ocr: null, ocrMaxPages: 3 };

describe("document detection", () => {
  it("detects by content, not by extension", async () => {
    expect(detectDocument(makePdf(["Salom"]), "x.txt")).toMatchObject({ ok: true, kind: "pdf" });
    expect(detectDocument(await makeDocx(["Salom"]), "x.pdf")).toMatchObject({ ok: true, kind: "docx" });
    expect(detectDocument(Buffer.from("# Sarlavha\nmatn"), "dars.md")).toMatchObject({ ok: true, kind: "md" });
    expect(detectDocument(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "a.jpg")).toMatchObject({ ok: true, kind: "image" });
  });
  it("rejects executables, macro documents, legacy .doc, empty and binary files", async () => {
    expect(detectDocument(Buffer.from("MZ\x90\x00"), "dars.pdf").ok).toBe(false);
    expect(detectDocument(await makeDocx(["x"], true), "dars.docx").ok).toBe(false);
    expect(detectDocument(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), "old.doc").ok).toBe(false);
    expect(detectDocument(new Uint8Array(), "a.txt").ok).toBe(false);
    expect(detectDocument(Buffer.from([0x41, 0x00, 0x42]), "a.txt").ok).toBe(false);
    expect(detectDocument(Buffer.from([0xc3, 0x28, 0x41]), "a.txt").ok).toBe(false); // invalid UTF-8
  });
});

describe("document extraction", () => {
  it("extracts text PDFs with page references", async () => {
    const pdf = makePdf([LESSON_SNIPPET.slice(0, 150), LESSON_SNIPPET.slice(150)]);
    const r = await extractDocument("pdf", pdf, limits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pageCount).toBe(2);
    expect(r.sections[0]!.ref).toMatch(/^p\.1/);
    expect(r.sections.some((s) => s.ref.startsWith("p.2"))).toBe(true);
    expect(r.text).toContain("push metodi");
  });

  it("extracts DOCX text without running anything", async () => {
    const r = await extractDocument("docx", await makeDocx(LESSON_SNIPPET.split(". ")), limits);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toContain("indekslar noldan boshlanadi");
  });

  it("rejects scanned PDFs when OCR is disabled, and PDFs over the page limit", async () => {
    const scanned = await extractDocument("pdf", makePdf(["", ""]), limits);
    expect(scanned.ok).toBe(false);
    if (!scanned.ok) expect(scanned.reason).toMatch(/skanerlangan/);
    const big = await extractDocument("pdf", makePdf(Array.from({ length: 7 }, () => LESSON_SNIPPET.slice(0, 100))), limits);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.reason).toMatch(/pages/);
  });

  it("refuses to invent text from unreadable files", async () => {
    const r = await extractDocument("txt", Buffer.from("@@@ ### $$$ %%% ^^^ &&& *** ((( ))) !!! ~~~ ``` ;;; ::: ,,, ... --- +++ === ||| \\\\ /// ??? <<< >>>"), limits);
    expect(r.ok).toBe(false);
  });

  it("splits markdown into sections under headings", () => {
    const secs = buildSections([{ page: null, text: "# Kirish\n\nBirinchi paragraf.\n\n## Metodlar\n\npush haqida.\n\npop haqida." }], true);
    expect(secs.map((s) => s.ref)).toEqual(["§ Kirish ¶1-2", "§ Metodlar ¶3-5"]);
  });

  it("times out instead of hanging", async () => {
    const hangingOcr = () => new Promise<string[]>(() => {});
    const r = await extractDocument("image", Buffer.from([0xff, 0xd8, 0xff]), { ...limits, ocr: hangingOcr, timeoutMs: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/timed out/);
  });
});
