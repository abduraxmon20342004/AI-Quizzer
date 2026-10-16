import { GAME_TYPES } from "../domain/gameTypes.js";
import type { GroupSettings } from "../domain/settings.js";
import { isValidTimezone } from "../domain/time.js";

/**
 * Editable settings for the admin panel. Each field parses admin text input into a new settings object;
 * the whole object is then validated (schedule fit, weekly report timing, ...) before saving.
 */
export interface SettingField {
  key: string;
  label: string;
  hint: string;
  show(s: GroupSettings): string;
  apply(s: GroupSettings, input: string): GroupSettings | string;
}

const HHMM = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/;

function time(key: string, label: string, pick: (s: GroupSettings) => string, put: (s: GroupSettings, v: string) => GroupSettings): SettingField {
  return {
    key,
    label,
    hint: "Vaqtni HH:MM ko'rinishida yuboring, masalan 18:00",
    show: pick,
    apply(s, input) {
      const m = input.trim().match(HHMM);
      if (!m) return "Format noto'g'ri. Masalan: 18:00";
      return put(s, `${m[1]!.padStart(2, "0")}:${m[2]}`);
    },
  };
}

function int(key: string, label: string, min: number, max: number, pick: (s: GroupSettings) => number, put: (s: GroupSettings, v: number) => GroupSettings, unit = ""): SettingField {
  return {
    key,
    label,
    hint: `${min}–${max} oralig'idagi butun son yuboring${unit ? ` (${unit})` : ""}.`,
    show: (s) => `${pick(s)}${unit ? ` ${unit}` : ""}`,
    apply(s, input) {
      const n = Number(input.trim().replace(",", "."));
      if (!Number.isInteger(n) || n < min || n > max) return `${min}–${max} oralig'idagi butun son kerak.`;
      return put(s, n);
    },
  };
}

function text(key: string, label: string, max: number, pick: (s: GroupSettings) => string, put: (s: GroupSettings, v: string) => GroupSettings): SettingField {
  return {
    key,
    label,
    hint: `Matn yuboring (ko'pi bilan ${max} belgi). Tozalash uchun "-" yuboring.`,
    show: (s) => pick(s) || "—",
    apply(s, input) {
      const v = input.trim() === "-" ? "" : input.trim();
      if (v.length > max) return `Ko'pi bilan ${max} belgi.`;
      return put(s, v);
    },
  };
}

export const SETTING_FIELDS: SettingField[] = [
  time("st", "Boshlanish vaqti", (s) => s.startTime, (s, v) => ({ ...s, startTime: v })),
  time("et", "Tugash vaqti (kunlik hisobot)", (s) => s.endTime, (s, v) => ({ ...s, endTime: v })),
  int("qn", "Kunlik savollar soni", 1, 20, (s) => s.questionsPerDay, (s, v) => ({ ...s, questionsPerDay: v })),
  {
    key: "as",
    label: "Javob vaqti",
    hint: "Daqiqalarda yuboring (masalan 10). 0.5 = 30 soniya.",
    show: (s) => `${s.answerSeconds / 60} daq`,
    apply(s, input) {
      const n = Number(input.trim().replace(",", "."));
      if (!Number.isFinite(n) || n < 0.5 || n > 120) return "0.5 dan 120 gacha daqiqa kiriting.";
      return { ...s, answerSeconds: Math.round(n * 60) };
    },
  },
  int("sp", "Savollar oralig'i", 1, 600, (s) => s.spacingMinutes, (s, v) => ({ ...s, spacingMinutes: v }), "daq"),
  {
    key: "tz",
    label: "Vaqt zonasi",
    hint: "IANA nomini yuboring, masalan Asia/Tashkent",
    show: (s) => s.timezone,
    apply(s, input) {
      const v = input.trim();
      return isValidTimezone(v) ? { ...s, timezone: v } : "Noma'lum vaqt zonasi. Masalan: Asia/Tashkent";
    },
  },
  int("wd", "Haftalik hisobot kuni (1=Du … 7=Ya)", 1, 7, (s) => s.weeklyReport.day, (s, v) => ({ ...s, weeklyReport: { ...s.weeklyReport, day: v } })),
  time("wt", "Haftalik hisobot vaqti", (s) => s.weeklyReport.time, (s, v) => ({ ...s, weeklyReport: { ...s.weeklyReport, time: v } })),
  {
    key: "dm",
    label: "Qiyinlik aralashmasi (oson o'rta qiyin)",
    hint: "Uchta son yuboring, masalan: 2 3 1",
    show: (s) => `${s.difficultyMix.easy} ${s.difficultyMix.medium} ${s.difficultyMix.hard}`,
    apply(s, input) {
      const parts = input.trim().split(/[\s,;/]+/).map(Number);
      if (parts.length !== 3 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 20)) return "Uchta 0–20 butun son kerak, masalan: 2 3 1";
      return { ...s, difficultyMix: { easy: parts[0]!, medium: parts[1]!, hard: parts[2]! } };
    },
  },
  int("pe", "Ball: oson", 0, 100, (s) => s.points.easy, (s, v) => ({ ...s, points: { ...s.points, easy: v } })),
  int("pm", "Ball: o'rta", 0, 100, (s) => s.points.medium, (s, v) => ({ ...s, points: { ...s.points, medium: v } })),
  int("ph", "Ball: qiyin", 0, 100, (s) => s.points.hard, (s, v) => ({ ...s, points: { ...s.points, hard: v } })),
  int("pt", "Ball: to'g'ri/noto'g'ri", 0, 100, (s) => s.points.trueFalse, (s, v) => ({ ...s, points: { ...s.points, trueFalse: v } })),
  int("po", "Ball: emoji", 0, 100, (s) => s.points.emoji, (s, v) => ({ ...s, points: { ...s.points, emoji: v } })),
  {
    key: "pg",
    label: "So'zni top: bosqich ballari",
    hint: "Uchta son yuboring, masalan: 15 10 5",
    show: (s) => s.points.guessStages.join(" / "),
    apply(s, input) {
      const p = input.trim().split(/[\s,;/]+/).map(Number);
      if (p.length !== 3 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 100)) return "Uchta 0–100 butun son kerak, masalan: 15 10 5";
      return { ...s, points: { ...s.points, guessStages: [p[0]!, p[1]!, p[2]!] } };
    },
  },
  int("se", "Seriya: necha kunda bonus", 2, 60, (s) => s.streak.every, (s, v) => ({ ...s, streak: { ...s.streak, every: v } }), "kun"),
  int("sb", "Seriya bonusi", 0, 200, (s) => s.streak.bonus, (s, v) => ({ ...s, streak: { ...s.streak, bonus: v } }), "ball"),
  {
    key: "bu",
    label: "Kunlik AI byudjeti (USD)",
    hint: "Masalan: 3 yoki 0.5",
    show: (s) => `$${s.aiDailyBudgetUsd}`,
    apply(s, input) {
      const n = Number(input.trim().replace(",", ".").replace("$", ""));
      return Number.isFinite(n) && n >= 0 && n <= 1000 ? { ...s, aiDailyBudgetUsd: n } : "0–1000 oralig'ida son kiriting.";
    },
  },
  {
    key: "sr",
    label: "Darsdan savollar ulushi (qolgani qo'shimcha)",
    hint: "Foizda yuboring, masalan 80",
    show: (s) => `${Math.round(s.sourceRatio * 100)}%`,
    apply(s, input) {
      const n = Number(input.trim().replace("%", ""));
      return Number.isFinite(n) && n >= 0 && n <= 100 ? { ...s, sourceRatio: n / 100 } : "0–100 oralig'ida foiz kiriting.";
    },
  },
  int("rr", "Takrorlamaslik muddati", 0, 365, (s) => s.recentRepeatDays, (s, v) => ({ ...s, recentRepeatDays: v }), "kun"),
  int("bd", "Oldindan tayyorlash", 1, 14, (s) => s.bankBufferDays, (s, v) => ({ ...s, bankBufferDays: v }), "kun"),
  text("tp", "Mavzu", 200, (s) => s.topic, (s, v) => ({ ...s, topic: v })),
  text("lv", "Yosh / daraja", 100, (s) => s.level, (s, v) => ({ ...s, level: v })),
  {
    key: "ln",
    label: "O'quvchilar tili",
    hint: "uz, ru yoki en yuboring",
    show: (s) => s.language,
    apply(s, input) {
      const v = input.trim().toLowerCase();
      return v === "uz" || v === "ru" || v === "en" ? { ...s, language: v } : "uz, ru yoki en.";
    },
  },
];

export const TOGGLES: { key: string; label: string; get(s: GroupSettings): boolean; set(s: GroupSettings, v: boolean): GroupSettings }[] = [
  { key: "am", label: "Avtomatik tasdiqlash (barcha tekshiruvdan o'tganlar)", get: (s) => s.approvalMode === "auto", set: (s, v) => ({ ...s, approvalMode: v ? "auto" : "manual" }) },
  { key: "ag", label: "Matnli javoblarni AI tekshirsin", get: (s) => s.aiGradingEnabled, set: (s, v) => ({ ...s, aiGradingEnabled: v }) },
  { key: "mv", label: "Boshqa tildagi javoblarni qabul qilish", get: (s) => s.allowMultilingualVariants, set: (s, v) => ({ ...s, allowMultilingualVariants: v }) },
  { key: "hr", label: "So'rovnoma natijalarini yopilguncha yashirish", get: (s) => s.pollHideResultsUntilClose, set: (s, v) => ({ ...s, pollHideResultsUntilClose: v }) },
  { key: "si", label: "Hisobotda nofaol bo'lim", get: (s) => s.showInactiveSection, set: (s, v) => ({ ...s, showInactiveSection: v }) },
  { key: "sk", label: "Seriya bonuslari", get: (s) => s.streak.enabled, set: (s, v) => ({ ...s, streak: { ...s.streak, enabled: v } }) },
];

export function fieldByKey(key: string): SettingField | undefined {
  return SETTING_FIELDS.find((f) => f.key === key);
}

export const GAME_LIST = GAME_TYPES;
