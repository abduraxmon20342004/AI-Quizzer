/**
 * Split extracted text into citeable sections with page/paragraph references, e.g. "p.3 ¶2-4" or "§ Massivlar ¶1-2".
 * Sections are ~1200 characters so excerpts sent to the AI stay small.
 */
export interface Section {
  ref: string;
  text: string;
}

export interface PageText {
  page: number | null;
  text: string;
}

const TARGET = 1200;
const MAX = 2400;

function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/[ \t]+/g, " ").replace(/\n(?!\n)/g, " ").trim())
    .filter((p) => p.length > 0);
}

function hardSplit(p: string): string[] {
  if (p.length <= MAX) return [p];
  const out: string[] = [];
  const sentences = p.split(/(?<=[.!?])\s+/);
  let cur = "";
  for (const s of sentences) {
    if ((cur + " " + s).length > TARGET && cur) {
      out.push(cur.trim());
      cur = "";
    }
    cur += " " + s;
    while (cur.length > MAX) {
      out.push(cur.slice(0, MAX).trim());
      cur = cur.slice(MAX);
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function buildSections(pages: PageText[], markdown = false): Section[] {
  const sections: Section[] = [];
  let heading = "";
  for (const page of pages) {
    const paras = paragraphs(page.text).flatMap(hardSplit);
    let buf: string[] = [];
    let first = 1;
    const flush = (last: number) => {
      if (!buf.length) return;
      const where = page.page ? `p.${page.page} ` : heading ? `§ ${heading.slice(0, 40)} ` : "";
      const range = first === last ? `¶${first}` : `¶${first}-${last}`;
      sections.push({ ref: `${where}${range}`.trim(), text: buf.join("\n") });
      buf = [];
    };
    paras.forEach((p, i) => {
      const n = i + 1;
      if (markdown && /^#{1,6}\s/.test(p)) {
        flush(n - 1);
        heading = p.replace(/^#{1,6}\s*/, "");
        first = n;
      }
      if (!buf.length) first = n;
      buf.push(p);
      if (buf.join("\n").length >= TARGET) flush(n);
    });
    flush(paras.length);
  }
  return sections;
}

/** Share of letters/digits among non-space characters: low values mean garbage extraction. */
export function textQuality(text: string): number {
  const nonSpace = text.replace(/\s+/g, "");
  if (!nonSpace.length) return 0;
  const good = (nonSpace.match(/[\p{L}\p{N}]/gu) ?? []).length;
  return good / nonSpace.length;
}
