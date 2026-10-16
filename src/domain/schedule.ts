import type { GroupSettings } from "./settings.js";
import { GAME_TYPES } from "./gameTypes.js";
import { atLocal, isValidTimezone, minutesToHHMM, parseHHMM, weekDates } from "./time.js";

export const GUESS_WORD_STAGES = 3;
/** Each guess-the-word clue stage must stay open at least this long. */
export const MIN_SECONDS_PER_CLUE_STAGE = 60;

export interface SlotTimes {
  slot: number;
  publishAt: Date;
  closeAt: Date;
  /** Start times of clue stages 2..3 (guess the word); stage 1 starts at publishAt. */
  clueAt: Date[];
}

/** Planned slot times for one local day. Questions never overlap by default (validated below). */
export function computeSlots(s: GroupSettings, localDate: string): SlotTimes[] {
  const start = atLocal(localDate, s.startTime, s.timezone).getTime();
  const out: SlotTimes[] = [];
  for (let i = 0; i < s.questionsPerDay; i++) {
    const publishAt = start + i * s.spacingMinutes * 60_000;
    const closeAt = publishAt + s.answerSeconds * 1000;
    const clueAt: Date[] = [];
    for (let k = 1; k < GUESS_WORD_STAGES; k++) {
      clueAt.push(new Date(publishAt + Math.floor((k * s.answerSeconds) / GUESS_WORD_STAGES) * 1000));
    }
    out.push({ slot: i, publishAt: new Date(publishAt), closeAt: new Date(closeAt), clueAt });
  }
  return out;
}

export function dayEnd(s: GroupSettings, localDate: string): Date {
  return atLocal(localDate, s.endTime, s.timezone);
}

/** How many questions fit between start and end with the given spacing and answer window. */
export function maxQuestionsThatFit(s: Pick<GroupSettings, "startTime" | "endTime" | "spacingMinutes" | "answerSeconds">): number {
  const windowSec = (parseHHMM(s.endTime).minutes - parseHHMM(s.startTime).minutes) * 60;
  if (windowSec < s.answerSeconds) return 0;
  return Math.floor((windowSec - s.answerSeconds) / (s.spacingMinutes * 60)) + 1;
}

/**
 * Validate a complete settings object. Returns human-readable (Uzbek, admin-facing) problems;
 * an empty array means the schedule is possible.
 */
export function validateSettings(s: GroupSettings): string[] {
  const errors: string[] = [];
  if (!isValidTimezone(s.timezone)) errors.push(`Vaqt zonasi noto'g'ri: "${s.timezone}". Masalan: Asia/Tashkent.`);

  const start = parseHHMM(s.startTime).minutes;
  const end = parseHHMM(s.endTime).minutes;
  if (start >= end) {
    errors.push(
      `Boshlanish (${s.startTime}) tugashdan (${s.endTime}) oldin bo'lishi kerak, ikkalasi ham bir kun ichida. ` +
        `Yarim tundan o'tadigan oynalar hozircha qo'llab-quvvatlanmaydi.`,
    );
    return errors;
  }

  const answerMin = s.answerSeconds / 60;
  if (s.answerSeconds > s.spacingMinutes * 60) {
    errors.push(
      `Javob vaqti (${fmtMin(answerMin)}) savollar oralig'idan (${s.spacingMinutes} daq) uzun — savollar ustma-ust tushadi. ` +
        `Javob vaqtini qisqartiring yoki oraliqni uzaytiring.`,
    );
  }

  const lastClose = start * 60 + (s.questionsPerDay - 1) * s.spacingMinutes * 60 + s.answerSeconds;
  if (lastClose > end * 60) {
    const fit = maxQuestionsThatFit(s);
    errors.push(
      `${s.questionsPerDay} ta savol sig'maydi: oxirgi savol ${minutesToHHMM(Math.ceil(lastClose / 60))} da yopiladi, ` +
        `tugash vaqti esa ${s.endTime}. Bu sozlamalarda ko'pi bilan ${fit} ta savol sig'adi. ` +
        `Savollar sonini kamaytiring, oraliqni qisqartiring yoki tugash vaqtini kechroq qiling.`,
    );
  }

  const usesGuessWord = s.activeDays.some((d) => s.weekdayGame[String(d) as "1"] === "guess_word");
  if (usesGuessWord && s.answerSeconds < GUESS_WORD_STAGES * MIN_SECONDS_PER_CLUE_STAGE) {
    errors.push(
      `"So'zni top" o'yinida 3 ta maslahat bor: javob vaqti kamida ${(GUESS_WORD_STAGES * MIN_SECONDS_PER_CLUE_STAGE) / 60} daqiqa bo'lishi kerak.`,
    );
  }

  for (const [day, game] of Object.entries(s.weekdayGame)) {
    if (game !== null && !(GAME_TYPES as readonly string[]).includes(game)) errors.push(`${day}-kun uchun noma'lum o'yin turi.`);
  }

  if (s.difficultyMix.easy + s.difficultyMix.medium + s.difficultyMix.hard === 0) {
    errors.push(`Qiyinlik aralashmasi bo'sh: kamida bitta qiyinlik darajasiga 0 dan katta ulush bering.`);
  }

  errors.push(...validateWeeklyReport(s));
  return errors;
}

/** The weekly report must never announce a final winner while game slots remain later in the same week. */
export function validateWeeklyReport(s: GroupSettings): string[] {
  const gameDays = s.activeDays.filter((d) => s.weekdayGame[String(d) as "1"] !== null);
  if (gameDays.length === 0) return [];
  const lastDay = Math.max(...gameDays);
  const { day, time } = s.weeklyReport;
  if (day < lastDay) {
    return [
      `Haftalik hisobot ${dayName(day)} kuni, lekin ${dayName(lastDay)} kuni hali o'yin bor. ` +
        `Hisobot kunini ${dayName(lastDay)} yoki undan keyinga qo'ying.`,
    ];
  }
  if (day === lastDay && parseHHMM(time).minutes < parseHHMM(s.endTime).minutes) {
    return [
      `Haftalik hisobot (${dayName(day)} ${time}) shu kungi o'yinlar tugashidan (${s.endTime}) oldin. ` +
        `Vaqtni ${s.endTime} yoki undan keyin qiling.`,
    ];
  }
  return [];
}

/** When the weekly report becomes due (it is also held until every daily report of the week is out). */
export function weeklyReportDueAt(s: GroupSettings, weekStart: string): Date {
  const date = weekDates(weekStart)[s.weeklyReport.day - 1]!;
  return atLocal(date, s.weeklyReport.time, s.timezone);
}

const DAY_NAMES = ["", "Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba", "Yakshanba"];
export function dayName(d: number): string {
  return DAY_NAMES[d] ?? String(d);
}

function fmtMin(m: number): string {
  return Number.isInteger(m) ? `${m} daq` : `${m.toFixed(1)} daq`;
}
