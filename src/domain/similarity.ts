import { createHash } from "node:crypto";
import { normalizeText } from "./normalize.js";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Stable JSON (sorted keys) so equal content always hashes the same. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

export function hashContent(v: unknown): string {
  return sha256(stableStringify(v));
}

/**
 * Character 4-gram shingles of normalized text. Character grams (not word grams) tolerate Uzbek's
 * agglutinative suffixes: "elementi" vs "elementining" still share almost all grams.
 */
export function shingles(text: string): Set<string> {
  const s = normalizeText(text)
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const out = new Set<string>();
  if (s.length < 4) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i + 4 <= s.length; i++) out.add(s.slice(i, i + 4));
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export const NEAR_DUPLICATE_THRESHOLD = 0.75;

export function isNearDuplicate(a: string, b: string, threshold = NEAR_DUPLICATE_THRESHOLD): boolean {
  return jaccard(shingles(a), shingles(b)) >= threshold;
}
