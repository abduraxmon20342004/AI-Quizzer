/**
 * File type detection by content (magic bytes), never by the claimed extension or MIME alone.
 * Macro-enabled Office files and anything unrecognized are rejected. Nothing uploaded is ever executed.
 */
export type DocKind = "pdf" | "docx" | "txt" | "md" | "image";

export type Detection = { ok: true; kind: DocKind; mime: string } | { ok: false; reason: string };

function startsWith(b: Uint8Array, sig: number[], offset = 0): boolean {
  return sig.every((v, i) => b[offset + i] === v);
}

function containsAscii(b: Uint8Array, needle: string): boolean {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).includes(Buffer.from(needle, "latin1"));
}

export function detectDocument(bytes: Uint8Array, fileName: string): Detection {
  if (bytes.byteLength === 0) return { ok: false, reason: "Fayl bo'sh." };
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { ok: true, kind: "pdf", mime: "application/pdf" };
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (containsAscii(bytes, "vbaProject.bin") || ext === "docm") return { ok: false, reason: "Makrosli hujjatlar (docm) qabul qilinmaydi." };
    if (containsAscii(bytes, "word/document.xml")) return { ok: true, kind: "docx", mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    return { ok: false, reason: "Bu ZIP/Office fayli DOCX emas. TXT, MD, PDF yoki DOCX yuboring." };
  }
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return { ok: true, kind: "image", mime: "image/png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ok: true, kind: "image", mime: "image/jpeg" };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return { ok: true, kind: "image", mime: "image/webp" };
  if (startsWith(bytes, [0x4d, 0x5a]) || startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return { ok: false, reason: "Dastur fayllari qabul qilinmaydi." };
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return { ok: false, reason: "Eski .doc formati qo'llab-quvvatlanmaydi. DOCX yoki PDF qilib saqlang." };
  // Plain text: must be valid UTF-8 without NUL bytes.
  if (bytes.includes(0)) return { ok: false, reason: "Fayl turi aniqlanmadi. TXT, MD, PDF yoki DOCX yuboring." };
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "Matn fayli UTF-8 kodlashda emas." };
  }
  return { ok: true, kind: ext === "md" || ext === "markdown" ? "md" : "txt", mime: ext === "md" ? "text/markdown" : "text/plain" };
}
