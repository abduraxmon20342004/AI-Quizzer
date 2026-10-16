/**
 * Answer normalization. Word/text answers: Unicode NFKC, unified Uzbek apostrophes, collapsed whitespace,
 * case-folded, outer punctuation stripped. Code answers keep case and meaningful punctuation; only
 * insignificant whitespace and phone "smart quotes" are normalized.
 */

// Every apostrophe-like character used for Uzbek o‘ / g‘ / tutuq belgisi (ʼ), mapped to ASCII '.
const APOSTROPHES = /[‘’ʻʼʽ`´′ʹˈ＇]/g;
const SMART_DOUBLE = /[“”„«»]/g;
const OUTER_PUNCT = /^[\s.,!?;:"'()[\]{}«»…—–-]+|[\s.,!?;:"'()[\]{}«»…—–-]+$/gu;

export function unifyApostrophes(s: string): string {
  return s.replace(APOSTROPHES, "'");
}

/** Normalization for single words / short phrases (guess the word, accepted variants). */
export function normalizeWord(input: string): string {
  let s = input.normalize("NFKC");
  s = unifyApostrophes(s).replace(SMART_DOUBLE, '"');
  s = s.replace(/\s+/gu, " ").trim();
  s = s.toLowerCase();
  s = s.replace(OUTER_PUNCT, "");
  return s;
}

const UZ_CYR: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m",
  н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "x", ц: "ts", ч: "ch", ш: "sh", щ: "sh",
  ъ: "'", ь: "", ы: "i", э: "e", ю: "yu", я: "ya", ў: "o'", қ: "q", ғ: "g'", ҳ: "h",
};

/**
 * Uzbek Cyrillic -> Latin (same language, other script). Students write Uzbek in both scripts, so guesses
 * are also compared in Latin form. This is a script conversion, not a translation into another language.
 */
export function uzCyrillicToLatin(input: string): string {
  return input
    .toLowerCase()
    .replace(/(^|[^\p{L}])е/gu, "$1ye")
    .replace(/[Ѐ-ӿ]/g, (ch) => UZ_CYR[ch] ?? ch);
}

/** Normalization for free text sentences (keeps inner punctuation). */
export function normalizeText(input: string): string {
  let s = input.normalize("NFKC");
  s = unifyApostrophes(s).replace(SMART_DOUBLE, '"');
  return s.replace(/\s+/gu, " ").trim().toLowerCase();
}

const CODE_PUNCT = "(){}[];,.=+-*/<>!&|:?%^~";

/**
 * Canonical comparison key for code. Case is preserved (identifiers are case sensitive). Phone keyboards
 * turn quotes into curly quotes, which are never valid code, so they become ASCII. Spaces next to
 * punctuation are removed. For indentation-sensitive languages (Python) leading indentation is kept.
 */
export function codeKey(code: string, language = "javascript"): string {
  let s = code.normalize("NFC").replace(/\r\n?/g, "\n");
  s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const indentSensitive = /^(py|python)$/i.test(language);
  const lines = s
    .split("\n")
    .map((line) => line.replace(/\t/g, "    ").replace(/\s+$/u, ""))
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const indent = indentSensitive ? (line.match(/^ */)?.[0].length ?? 0) : 0;
      let body = line.trim().replace(/[ ]+/g, " ");
      for (const ch of CODE_PUNCT) {
        const esc = ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        body = body.replace(new RegExp(` ?${esc} ?`, "g"), ch);
      }
      return indentSensitive ? `${indent}:${body}` : body;
    });
  if (!indentSensitive) {
    // Statement terminators at line ends are optional in JS; compare without trailing semicolons.
    // "abc" and 'abc' are the same string literal when the text has no quotes, backticks or escapes.
    return lines.map((l) => l.replace(/;+$/, "").replace(/"([^"'`\\]*)"/g, "'$1'")).join("\n");
  }
  return lines.join("\n");
}

/** Damerau-free Levenshtein distance (small inputs only). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}
