import JSZip from "jszip";

/** Minimal valid PDF with one text page per entry (Helvetica, WinAnsi). Empty strings make image-like pages. */
export function makePdf(pages: string[]): Uint8Array {
  const objects: string[] = [];
  const kids: number[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let next = 4;
  for (const text of pages) {
    const pageId = next++;
    const contentId = next++;
    kids.push(pageId);
    const lines = text.split("\n");
    const ops = text
      ? `BT /F1 11 Tf 40 780 Td 14 TL ${lines.map((l) => `(${l.replace(/[\\()]/g, (c) => "\\" + c)}) Tj T*`).join(" ")} ET`
      : "0 0 1 rg 50 50 200 200 re f";
    objects[contentId] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

export async function makeDocx(paragraphs: string[], withMacro = false): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`).join("");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  if (withMacro) zip.file("word/vbaProject.bin", "fake macro");
  return new Uint8Array(await zip.generateAsync({ type: "uint8array" }));
}

export const LESSON_SNIPPET =
  "Massiv bir nechta qiymatni bitta o'zgaruvchida tartib bilan saqlaydigan tuzilma. JavaScriptda indekslar noldan boshlanadi, shuning uchun birinchi elementning indeksi 0 ga teng. push metodi massiv oxiriga yangi element qo'shadi. pop metodi esa massivning oxirgi elementini olib tashlaydi va shu elementni qaytaradi.";
