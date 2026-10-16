/** The six supported game types. Nothing else is allowed. */
export const GAME_TYPES = [
  "quiz_poll",
  "find_mistake",
  "guess_word",
  "true_false",
  "picture_quiz",
  "emoji_puzzle",
] as const;
export type GameType = (typeof GAME_TYPES)[number];

export function isGameType(v: unknown): v is GameType {
  return typeof v === "string" && (GAME_TYPES as readonly string[]).includes(v);
}

/** How a student answers each type. */
export const ANSWER_CHANNEL: Record<GameType, "poll" | "buttons" | "private_text"> = {
  quiz_poll: "poll",
  true_false: "poll",
  picture_quiz: "buttons",
  emoji_puzzle: "buttons",
  find_mistake: "private_text",
  guess_word: "private_text",
};

export function needsPrivateChat(t: GameType): boolean {
  return ANSWER_CHANNEL[t] === "private_text";
}

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const ORIGINS = ["source", "extra"] as const;
export type Origin = (typeof ORIGINS)[number];
