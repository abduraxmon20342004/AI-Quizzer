import { describe, expect, it } from "vitest";
import { validateDraft, type ValidationContext } from "../../src/domain/questionValidation.js";
import { hashContent } from "../../src/domain/similarity.js";

const section = "push metodi massiv oxiriga yangi element qo'shadi. pop metodi esa massivning oxirgi elementini olib tashlaydi.";
function ctx(over: Partial<ValidationContext> = {}): ValidationContext {
  return { sections: new Map([[7, section]]), assetIds: new Set([3]), existing: [], expectedGameType: "quiz_poll", expectedLanguage: "uz", readingLevel: "standard", ...over };
}
const quiz = (content: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  gameType: "quiz_poll",
  language: "uz",
  difficulty: "easy",
  origin: "source",
  content,
  sourceRefs: [{ sectionId: 7, ref: "p.1 ¶1" }],
  sourceExcerpt: "push metodi massiv oxiriga yangi element qo'shadi.",
  ...extra,
});
const good = { prompt: "Qaysi metod massiv oxiriga element qo'shadi?", options: ["push", "pop", "shift", "slice"], correctIndex: 0, explanation: "push oxiriga qo'shadi." };

describe("deterministic question validation", () => {
  it("accepts a well-formed grounded quiz question", () => {
    const r = validateDraft(quiz(good), ctx());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("rejects malformed or missing fields", () => {
    expect(validateDraft(quiz({ ...good, options: undefined }), ctx()).ok).toBe(false);
    expect(validateDraft({ ...quiz(good), difficulty: "extreme" }, ctx()).ok).toBe(false);
    expect(validateDraft(quiz({ ...good, unexpected: 1 }), ctx()).ok).toBe(false);
  });

  it("rejects duplicate options, all/none-of-the-above and answer clues in the prompt", () => {
    expect(validateDraft(quiz({ ...good, options: ["push", "Push", "shift", "slice"] }), ctx()).errors.join()).toMatch(/distinct/);
    expect(validateDraft(quiz({ ...good, options: ["push", "pop", "shift", "Hammasi to'g'ri"] }), ctx()).errors.join()).toMatch(/ambiguous/);
    expect(validateDraft(quiz({ ...good, prompt: "push nima qiladi, push metodi qaysi?" }), ctx()).errors.join()).toMatch(/answer clue/);
  });

  it("enforces Telegram limits (poll question 300, option 100)", () => {
    expect(validateDraft(quiz({ ...good, prompt: "x".repeat(301) }), ctx()).ok).toBe(false);
    expect(validateDraft(quiz({ ...good, options: ["y".repeat(101), "pop", "shift", "slice"] }), ctx()).ok).toBe(false);
  });

  it("requires a verbatim supporting excerpt for lesson questions and no references for extra questions", () => {
    expect(validateDraft(quiz(good, { sourceExcerpt: "push metodi elementni boshiga qo'shadi." }), ctx()).errors.join()).toMatch(/verbatim/);
    expect(validateDraft(quiz(good, { sourceRefs: [{ sectionId: 99, ref: "?" }] }), ctx()).errors.join()).toMatch(/unknown section/);
    expect(validateDraft(quiz(good, { origin: "extra" }), ctx()).errors.join()).toMatch(/must not claim/);
    expect(validateDraft(quiz(good, { origin: "extra", sourceRefs: [], sourceExcerpt: "" }), ctx()).ok).toBe(true);
  });

  it("rejects a question of another game type than the day's type", () => {
    expect(validateDraft(quiz(good), ctx({ expectedGameType: "emoji_puzzle" })).errors.join()).toMatch(/wrong game type/);
  });

  it("rejects duplicates and near duplicates of recent questions", () => {
    const hash = hashContent({ t: "quiz_poll", c: good });
    expect(validateDraft(quiz(good), ctx({ existing: [{ hash, text: good.prompt }] })).errors.join()).toMatch(/identical/);
    expect(validateDraft(quiz(good), ctx({ existing: [{ hash: "x", text: "Qaysi metod massiv oxiriga element qo'shadi" }] })).errors.join()).toMatch(/similar/);
  });

  it("checks game-specific rules: true/false, guess clues, emoji, find-the-mistake, picture assets", () => {
    const base = { language: "uz", difficulty: "easy", origin: "extra", sourceRefs: [], sourceExcerpt: "" };
    expect(validateDraft({ ...base, gameType: "true_false", content: { statement: "push oxiriga qo'shadimi?", isTrue: true, explanation: "ha" } }, ctx({ expectedGameType: "true_false" })).errors.join()).toMatch(/statement/);
    expect(
      validateDraft({ ...base, gameType: "guess_word", content: { answer: "massiv", acceptedVariants: [], clues: ["Bu massiv turidagi tuzilma", "Kvadrat qavsda yoziladi", "Elementlar vergul bilan"], explanation: "x" } }, ctx({ expectedGameType: "guess_word" })).errors.join(),
    ).toMatch(/reveals the answer/);
    expect(validateDraft({ ...base, gameType: "emoji_puzzle", content: { emojis: "🍎 olma", category: "Meva", options: ["a", "b", "c", "d"], correctIndex: 0, explanation: "x" } }, ctx({ expectedGameType: "emoji_puzzle" })).errors.join()).toMatch(/only emoji/);
    expect(
      validateDraft({ ...base, gameType: "find_mistake", content: { prompt: "Xatoni toping", codeLanguage: "js", code: "a.lenght", fixedCode: "a.lenght", acceptedFixes: [], mistakeDescription: "length", rubric: "length bilan yozilishi kerak", explanation: "x" } }, ctx({ expectedGameType: "find_mistake" })).errors.join(),
    ).toMatch(/identical/);
    expect(validateDraft({ ...base, gameType: "picture_quiz", content: { prompt: "Rasmda nima bor?", assetId: 9, options: ["a", "b", "c", "d"], correctIndex: 0, explanation: "x" } }, ctx({ expectedGameType: "picture_quiz" })).errors.join()).toMatch(/not an approved asset/);
  });
});
