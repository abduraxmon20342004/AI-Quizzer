// Manual OCR check (downloads tesseract language data on first run): npm run ocr:check
import { createCanvas } from "@napi-rs/canvas";
import { createOcr, renderPdfPages } from "../src/documents/ocr.js";
const canvas = createCanvas(900, 200);
const g = canvas.getContext("2d");
g.fillStyle = "white"; g.fillRect(0, 0, 900, 200);
g.fillStyle = "black"; g.font = "40px sans-serif";
g.fillText("Massiv elementlari indeks orqali olinadi", 20, 90);
const png = await canvas.encode("png");
const t0 = Date.now();
const ocr = createOcr({ langs: "eng", timeoutMs: 120000 });
const [text] = await ocr([png]);
console.log("OCR image:", JSON.stringify(text?.trim()), `${Date.now() - t0} ms`);
const { makePdf } = await import("../tests/fixtures.js");
const pages = await renderPdfPages(makePdf(["Massiv elementlari indeks orqali olinadi"]), 1);
console.log("rendered pages:", pages.length, "png bytes:", pages[0]?.byteLength);
const [pdfText] = await ocr(pages);
console.log("OCR rendered PDF:", JSON.stringify(pdfText?.trim()));
