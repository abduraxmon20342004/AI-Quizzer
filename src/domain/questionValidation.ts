import { CONTENT_SCHEMAS, QuestionDraft, questionText, type AnyContent, type ContentOf } from "./content.js";
import type { GameType } from "./gameTypes.js";
import { codeKey, normalizeText, normalizeWord } from "./normalize.js";
import { hashContent, isNearDuplicate } from "./similarity.js";
import { TG, tgLength } from "./telegramLimits.js";

export interface ValidationContext {
  /** Sections the generator was allowed to cite (id -> text). */
  sections: Map<number, string>;
  /** Approved picture assets of this group. */
  assetIds: Set<number>;
  /** Already-known questions of this group (bank + recently used) for duplicate checks. */
  existing: { hash: string; text: string }[];
  /** Expected game type of the batch: a different type is rejected, never silently switched. */
  expectedGameType: GameType;
  /** Expected student language. */
  expectedLanguage: string;
  /** Target reading level hint: "young" tightens sentence-length limits. */
  readingLevel: "young" | "standard";
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  draft?: QuestionDraft;
  content?: AnyContent;
  contentHash?: string;
  text?: string;
}

const AMBIGUOUS_OPTION = [
  /barchasi\s+to'g'ri/,
  /hammasi\s+to'g'ri/,
  /hech\s+biri/,
  /all of the above/,
  /none of the above/,
  /все\s+(вышеперечисленн|ответы)/,
  /ни\s+один/,
];

/** Deterministic gate run on every generated draft before AI review. */
export function validateDraft(raw: unknown, ctx: ValidationContext): ValidationResult {
  const errors: string[] = [];
  const parsed = QuestionDraft.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `schema: ${i.path.join(".")} ${i.message}`) };
  }
  const draft = parsed.data;
  if (draft.gameType !== ctx.expectedGameType) errors.push(`wrong game type ${draft.gameType}, expected ${ctx.expectedGameType}`);
  if (draft.language !== ctx.expectedLanguage) errors.push(`wrong language ${draft.language}, expected ${ctx.expectedLanguage}`);

  const schema = CONTENT_SCHEMAS[draft.gameType];
  const c = schema.safeParse(draft.content);
  if (!c.success) {
    return { ok: false, errors: [...errors, ...c.error.issues.map((i) => `content: ${i.path.join(".")} ${i.message}`)] };
  }
  const content = c.data as AnyContent;
  errors.push(...gameSpecificChecks(draft.gameType, content, ctx));
  errors.push(...sourceChecks(draft, ctx));

  const text = questionText(draft.gameType, content);
  errors.push(...readingLevelChecks(text, draft.gameType, ctx.readingLevel));

  const contentHash = hashContent({ t: draft.gameType, c: content });
  if (ctx.existing.some((e) => e.hash === contentHash)) errors.push("duplicate: identical question already exists");
  else if (ctx.existing.some((e) => isNearDuplicate(e.text, text))) errors.push("duplicate: too similar to an existing or recently used question");

  return { ok: errors.length === 0, errors, draft, content, contentHash, text };
}

function optionChecks(options: string[], correctIndex: number, prompt: string, errors: string[], label = "option") {
  if (correctIndex < 0 || correctIndex >= options.length) errors.push("correctIndex out of range");
  const norm = options.map(normalizeWord);
  if (new Set(norm).size !== norm.length) errors.push(`${label}s must be distinct`);
  for (const o of norm) {
    if (AMBIGUOUS_OPTION.some((re) => re.test(o))) errors.push(`ambiguous ${label} "${o}" (all/none of the above) is not allowed`);
  }
  const correct = norm[correctIndex];
  if (correct && correct.length >= 4 && normalizeText(prompt).includes(correct)) {
    errors.push("the prompt contains the correct answer (answer clue)");
  }
  // Weak distractors: options that are near copies of the correct answer, or trivially short.
  const lengths = options.map((o) => o.trim().length);
  const maxLen = Math.max(...lengths);
  const correctLen = lengths[correctIndex] ?? 0;
  if (options.length >= 3 && correctLen === maxLen && correctLen > 2.5 * Math.min(...lengths) && correctLen > 25) {
    errors.push("the correct option is conspicuously longer than the distractors");
  }
}

function gameSpecificChecks(gameType: GameType, content: AnyContent, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  switch (gameType) {
    case "quiz_poll": {
      const c = content as ContentOf<"quiz_poll">;
      if (c.options.length > TG.POLL_OPTIONS_MAX) errors.push("too many poll options");
      if (tgLength(c.prompt) > TG.POLL_QUESTION_MAX) errors.push("poll question too long for Telegram");
      optionChecks(c.options, c.correctIndex, c.prompt, errors);
      break;
    }
    case "true_false": {
      const c = content as ContentOf<"true_false">;
      if (/\?\s*$/.test(c.statement)) errors.push("true/false statement must be a statement, not a question");
      if (/\b(ba'zan|ba'zida|sometimes|иногда)\b/i.test(normalizeText(c.statement))) {
        errors.push("true/false statement uses a vague qualifier and may be neither true nor false");
      }
      break;
    }
    case "find_mistake": {
      const c = content as ContentOf<"find_mistake">;
      if (codeKey(c.code, c.codeLanguage) === codeKey(c.fixedCode, c.codeLanguage)) errors.push("fixed code is identical to the buggy code");
      if (c.code.split("\n").length > 25) errors.push("code is longer than 25 lines");
      if (/```/.test(c.code) || /```/.test(c.fixedCode)) errors.push("code must not contain markdown fences");
      if (tgLength(c.prompt) + tgLength(c.code) + 200 > TG.MESSAGE_MAX) errors.push("message would exceed Telegram length");
      for (const fix of c.acceptedFixes) {
        if (codeKey(fix, c.codeLanguage) === codeKey(c.code, c.codeLanguage)) errors.push("an accepted fix equals the buggy code");
      }
      break;
    }
    case "guess_word": {
      const c = content as ContentOf<"guess_word">;
      const answers = [c.answer, ...c.acceptedVariants].map(normalizeWord).filter(Boolean);
      c.clues.forEach((clue, i) => {
        const n = normalizeText(clue);
        for (const a of answers) {
          if (a.length >= 3 && new RegExp(`(^|[^\\p{L}])${escapeRe(a)}`, "u").test(n)) {
            errors.push(`clue ${i + 1} reveals the answer`);
            break;
          }
        }
      });
      if (new Set(c.clues.map(normalizeText)).size !== 3) errors.push("clues must be different");
      break;
    }
    case "picture_quiz": {
      const c = content as ContentOf<"picture_quiz">;
      if (!ctx.assetIds.has(c.assetId)) errors.push(`picture asset ${c.assetId} is not an approved asset of this group`);
      if (tgLength(c.prompt) > TG.CAPTION_MAX) errors.push("caption too long");
      optionChecks(c.options, c.correctIndex, c.prompt, errors);
      break;
    }
    case "emoji_puzzle": {
      const c = content as ContentOf<"emoji_puzzle">;
      if (/[\p{L}]/u.test(c.emojis)) errors.push("emoji puzzle must contain only emoji (no letters)");
      const pictographs = c.emojis.match(/\p{Extended_Pictographic}/gu) ?? [];
      if (pictographs.length < 2) errors.push("emoji puzzle needs at least two emoji");
      optionChecks(c.options, c.correctIndex, c.category, errors);
      break;
    }
  }
  return errors;
}

function sourceChecks(d: QuestionDraft, ctx: ValidationContext): string[] {
  const errors: string[] = [];
  if (d.origin === "source") {
    if (d.sourceRefs.length === 0) errors.push("source question without source references");
    if (d.sourceExcerpt.trim().length < 10) errors.push("source question without a supporting excerpt");
    const cited = d.sourceRefs.map((r) => ctx.sections.get(r.sectionId));
    if (cited.some((t) => t === undefined)) errors.push("source reference points to an unknown section");
    const excerpt = squash(d.sourceExcerpt);
    if (excerpt && !cited.some((t) => t !== undefined && squash(t).includes(excerpt))) {
      errors.push("supporting excerpt is not a verbatim quote from the cited section");
    }
  } else if (d.sourceRefs.length > 0) {
    errors.push("extra question must not claim source references");
  }
  return errors;
}

/** Simple reading-level heuristics: children's questions use short sentences and words. */
function readingLevelChecks(text: string, gameType: GameType, level: "young" | "standard"): string[] {
  if (gameType === "find_mistake") return [];
  const maxWordsPerSentence = level === "young" ? 22 : 35;
  const sentences = text.split(/[.!?\n]+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    if (s.split(/\s+/).length > maxWordsPerSentence) return [`sentence too long for the reading level (> ${maxWordsPerSentence} words)`];
  }
  return [];
}

function squash(s: string): string {
  return normalizeText(s).replace(/[^\p{L}\p{N}]+/gu, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
