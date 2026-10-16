import { z } from "zod";
import { DIFFICULTIES, GAME_TYPES, ORIGINS, type GameType } from "./gameTypes.js";
import { TG } from "./telegramLimits.js";

/** Strict per-game content schemas. Anything malformed or missing is rejected before review. */

const explanation = z.string().trim().min(1).max(400);
const option = z.string().trim().min(1).max(TG.POLL_OPTION_MAX);
const buttonOption = z.string().trim().min(1).max(TG.BUTTON_TEXT_SOFT_MAX);

export const QuizPollContent = z.strictObject({
  prompt: z.string().trim().min(5).max(TG.POLL_QUESTION_MAX),
  options: z.array(option).min(3).max(6),
  correctIndex: z.number().int().min(0),
  explanation,
});

export const TrueFalseContent = z.strictObject({
  statement: z.string().trim().min(5).max(TG.POLL_QUESTION_MAX),
  isTrue: z.boolean(),
  explanation,
});

export const FindMistakeContent = z.strictObject({
  prompt: z.string().trim().min(5).max(300),
  codeLanguage: z.string().trim().min(1).max(20),
  code: z.string().min(5).max(1500),
  fixedCode: z.string().min(5).max(1500),
  /** Alternative complete fixed versions that are also correct. */
  acceptedFixes: z.array(z.string().min(1).max(1500)).max(5),
  mistakeDescription: z.string().trim().min(3).max(300),
  rubric: z.string().trim().min(10).max(800),
  explanation,
});

export const GuessWordContent = z.strictObject({
  answer: z.string().trim().min(1).max(60),
  acceptedVariants: z.array(z.string().trim().min(1).max(60)).max(10),
  clues: z.tuple([
    z.string().trim().min(5).max(300),
    z.string().trim().min(5).max(300),
    z.string().trim().min(5).max(300),
  ]),
  explanation,
});

export const PictureQuizContent = z.strictObject({
  prompt: z.string().trim().min(5).max(300),
  assetId: z.number().int().positive(),
  options: z.array(buttonOption).length(4),
  correctIndex: z.number().int().min(0).max(3),
  explanation,
});

export const EmojiPuzzleContent = z.strictObject({
  emojis: z.string().trim().min(1).max(40),
  category: z.string().trim().min(2).max(100),
  options: z.array(buttonOption).length(4),
  correctIndex: z.number().int().min(0).max(3),
  explanation,
});

export const CONTENT_SCHEMAS = {
  quiz_poll: QuizPollContent,
  true_false: TrueFalseContent,
  find_mistake: FindMistakeContent,
  guess_word: GuessWordContent,
  picture_quiz: PictureQuizContent,
  emoji_puzzle: EmojiPuzzleContent,
} as const;

export type ContentOf<T extends GameType> = z.infer<(typeof CONTENT_SCHEMAS)[T]>;
export type AnyContent = ContentOf<GameType>;

export const SourceRef = z.strictObject({
  sectionId: z.number().int().positive(),
  ref: z.string().max(100),
});
export type SourceRef = z.infer<typeof SourceRef>;

/** A full question as stored in question_versions (content + metadata). */
export const QuestionDraft = z.strictObject({
  gameType: z.enum(GAME_TYPES),
  language: z.enum(["uz", "ru", "en"]),
  difficulty: z.enum(DIFFICULTIES),
  origin: z.enum(ORIGINS),
  content: z.record(z.string(), z.unknown()),
  sourceRefs: z.array(SourceRef).max(5),
  sourceExcerpt: z.string().max(600),
});
export type QuestionDraft = z.infer<typeof QuestionDraft>;

export function parseContent<T extends GameType>(gameType: T, content: unknown): ContentOf<T> {
  return CONTENT_SCHEMAS[gameType].parse(content) as ContentOf<T>;
}

/** Options shown to students (polls and buttons), with the correct index. */
export function choiceView(gameType: GameType, content: AnyContent, tfLabels: [string, string]): { options: string[]; correctIndex: number } | null {
  switch (gameType) {
    case "quiz_poll":
    case "picture_quiz":
    case "emoji_puzzle": {
      const c = content as { options: string[]; correctIndex: number };
      return { options: c.options, correctIndex: c.correctIndex };
    }
    case "true_false":
      return { options: [...tfLabels], correctIndex: (content as ContentOf<"true_false">).isTrue ? 0 : 1 };
    default:
      return null;
  }
}

/** Short human summary for admin review and similarity checks. */
export function questionText(gameType: GameType, content: AnyContent): string {
  switch (gameType) {
    case "quiz_poll":
      return (content as ContentOf<"quiz_poll">).prompt;
    case "true_false":
      return (content as ContentOf<"true_false">).statement;
    case "find_mistake": {
      const c = content as ContentOf<"find_mistake">;
      return `${c.prompt}\n${c.code}`;
    }
    case "guess_word": {
      const c = content as ContentOf<"guess_word">;
      return `${c.answer} ${c.clues.join(" ")}`;
    }
    case "picture_quiz": {
      const c = content as ContentOf<"picture_quiz">;
      return `${c.prompt} ${c.options.join(" ")}`;
    }
    case "emoji_puzzle": {
      const c = content as ContentOf<"emoji_puzzle">;
      return `${c.emojis} ${c.category} ${c.options[c.correctIndex]}`;
    }
  }
}
