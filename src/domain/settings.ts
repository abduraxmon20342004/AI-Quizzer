import { z } from "zod";
import { GAME_TYPES } from "./gameTypes.js";

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");
const gameOrOff = z.enum(GAME_TYPES).nullable();

/**
 * Per-group settings (stored as validated JSON in group_settings). Every field is editable by a bot admin;
 * edits only affect future questions (published questions keep their snapshot).
 */
export const GroupSettingsSchema = z.object({
  language: z.enum(["uz", "ru", "en"]),
  timezone: z.string().min(1),
  /** ISO weekdays (1 = Monday ... 7 = Sunday) on which games run. */
  activeDays: z.array(z.number().int().min(1).max(7)),
  startTime: HHMM,
  endTime: HHMM,
  questionsPerDay: z.number().int().min(1).max(20),
  answerSeconds: z.number().int().min(30).max(7200),
  spacingMinutes: z.number().int().min(1).max(600),
  /** Weekday -> game type; null = no game (e.g. Sunday is weekly-report only). */
  weekdayGame: z.object({
    "1": gameOrOff,
    "2": gameOrOff,
    "3": gameOrOff,
    "4": gameOrOff,
    "5": gameOrOff,
    "6": gameOrOff,
    "7": gameOrOff,
  }),
  /** Relative weights for easy/medium/hard. */
  difficultyMix: z.object({
    easy: z.number().int().min(0).max(20),
    medium: z.number().int().min(0).max(20),
    hard: z.number().int().min(0).max(20),
  }),
  points: z.object({
    easy: z.number().int().min(0).max(100),
    medium: z.number().int().min(0).max(100),
    hard: z.number().int().min(0).max(100),
    trueFalse: z.number().int().min(0).max(100),
    emoji: z.number().int().min(0).max(100),
    guessStages: z.tuple([z.number().int().min(0).max(100), z.number().int().min(0).max(100), z.number().int().min(0).max(100)]),
  }),
  streak: z.object({
    enabled: z.boolean(),
    every: z.number().int().min(2).max(60),
    bonus: z.number().int().min(0).max(200),
  }),
  /** Share of lesson-grounded questions (rest are extra same-topic questions). Source count rounds up. */
  sourceRatio: z.number().min(0).max(1),
  weeklyReport: z.object({ day: z.number().int().min(1).max(7), time: HHMM }),
  approvalMode: z.enum(["manual", "auto"]),
  aiDailyBudgetUsd: z.number().min(0).max(1000),
  aiGradingEnabled: z.boolean(),
  allowMultilingualVariants: z.boolean(),
  bankBufferDays: z.number().int().min(1).max(14),
  recentRepeatDays: z.number().int().min(0).max(365),
  showInactiveSection: z.boolean(),
  pollHideResultsUntilClose: z.boolean(),
  topic: z.string().max(200),
  level: z.string().max(100),
});

export type GroupSettings = z.infer<typeof GroupSettingsSchema>;
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export function defaultSettings(timezone = "Asia/Tashkent", language: "uz" | "ru" | "en" = "uz"): GroupSettings {
  return {
    language,
    timezone,
    activeDays: [1, 2, 3, 4, 5, 6],
    startTime: "18:00",
    endTime: "21:00",
    questionsPerDay: 6,
    answerSeconds: 600,
    spacingMinutes: 30,
    weekdayGame: {
      "1": "quiz_poll",
      "2": "find_mistake",
      "3": "guess_word",
      "4": "true_false",
      "5": "picture_quiz",
      "6": "emoji_puzzle",
      "7": null,
    },
    difficultyMix: { easy: 2, medium: 3, hard: 1 },
    points: { easy: 5, medium: 10, hard: 15, trueFalse: 5, emoji: 5, guessStages: [15, 10, 5] },
    streak: { enabled: true, every: 5, bonus: 10 },
    sourceRatio: 0.8,
    weeklyReport: { day: 7, time: "18:00" },
    approvalMode: "manual",
    aiDailyBudgetUsd: 3,
    aiGradingEnabled: true,
    allowMultilingualVariants: false,
    bankBufferDays: 2,
    recentRepeatDays: 60,
    showInactiveSection: true,
    // Off by default: the parameter is new (Bot API 10.x) and was verified from the docs only, not against live
    // Telegram. Admins can enable it in "AI sozlamalari" after a test in their group.
    pollHideResultsUntilClose: false,
    topic: "",
    level: "",
  };
}

/** Parse stored JSON, filling fields added by later versions with defaults. */
export function parseStoredSettings(raw: unknown, fallbackTz: string, fallbackLang: "uz" | "ru" | "en"): GroupSettings {
  const base = defaultSettings(fallbackTz, fallbackLang);
  const merged = { ...base, ...(typeof raw === "object" && raw ? (raw as object) : {}) };
  return GroupSettingsSchema.parse(merged);
}

export function gameForWeekday(s: GroupSettings, weekday: number): (typeof GAME_TYPES)[number] | null {
  if (!s.activeDays.includes(weekday)) return null;
  return s.weekdayGame[String(weekday) as keyof GroupSettings["weekdayGame"]] ?? null;
}
