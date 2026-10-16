import { z } from "zod";
import type { GameType } from "../domain/gameTypes.js";

/**
 * Schemas the model must fill (structured outputs). They stay simple (no length constraints) because the
 * deterministic validator (domain/questionValidation.ts) enforces every limit afterwards.
 */
const base = {
  origin: z.enum(["source", "extra"]),
  difficulty: z.enum(["easy", "medium", "hard"]),
  sourceSectionIds: z.array(z.number().int()).describe("ids of the cited sections; empty for extra questions"),
  supportingExcerpt: z.string().describe("verbatim quote from a cited section that supports the answer; empty for extra"),
};

export const GEN_ITEM_SCHEMAS = {
  quiz_poll: z.object({ ...base, prompt: z.string(), options: z.array(z.string()), correctIndex: z.number().int(), explanation: z.string() }),
  true_false: z.object({ ...base, statement: z.string(), isTrue: z.boolean(), explanation: z.string() }),
  find_mistake: z.object({
    ...base,
    prompt: z.string(),
    codeLanguage: z.string(),
    code: z.string(),
    fixedCode: z.string(),
    acceptedFixes: z.array(z.string()),
    mistakeDescription: z.string(),
    rubric: z.string(),
    explanation: z.string(),
  }),
  guess_word: z.object({ ...base, answer: z.string(), acceptedVariants: z.array(z.string()), clues: z.array(z.string()), explanation: z.string() }),
  picture_quiz: z.object({ ...base, prompt: z.string(), assetId: z.number().int(), options: z.array(z.string()), correctIndex: z.number().int(), explanation: z.string() }),
  emoji_puzzle: z.object({ ...base, emojis: z.string(), category: z.string(), options: z.array(z.string()), correctIndex: z.number().int(), explanation: z.string() }),
} as const;

export type GenItem<T extends GameType = GameType> = z.infer<(typeof GEN_ITEM_SCHEMAS)[T]>;

export function generationSchema(t: GameType) {
  return z.object({
    items: z.array(GEN_ITEM_SCHEMAS[t]),
    cannotGenerate: z.boolean().describe("true when this game type cannot be made clearly from the material/topic"),
    cannotGenerateReason: z.string(),
  });
}
export type GenerationOutput = { items: GenItem[]; cannotGenerate: boolean; cannotGenerateReason: string };

export const ReviewSchema = z.object({
  reviews: z.array(
    z.object({
      itemId: z.string(),
      verdict: z.enum(["approve", "reject"]),
      problems: z.array(z.string()),
      singleCorrectAnswer: z.boolean(),
      clearWording: z.boolean(),
      noAnswerClue: z.boolean(),
      distractorsPlausible: z.boolean(),
      supportedBySource: z.boolean().describe("for source questions: the excerpt supports the answer; true for extra"),
      factuallyCorrect: z.boolean(),
      factualConfidence: z.enum(["high", "low"]),
      ageAppropriate: z.boolean(),
      safe: z.boolean(),
      readingLevelOk: z.boolean(),
      unambiguous: z.boolean().describe("emoji/picture/guess-word: exactly one reasonable answer"),
    }),
  ),
});
export type ReviewOutput = z.infer<typeof ReviewSchema>;

export const GradeSchema = z.object({
  verdict: z.enum(["correct", "incorrect", "needs_review"]),
  reason: z.string().describe("one short sentence for the teacher"),
});
export type GradeOutput = z.infer<typeof GradeSchema>;

export const PictureReviewSchema = z.object({
  visibleText: z.string().describe("all text visible in the image, verbatim; empty if none"),
  matchesDescription: z.boolean(),
  childSafe: z.boolean(),
  problems: z.array(z.string()),
});
export type PictureReviewOutput = z.infer<typeof PictureReviewSchema>;
