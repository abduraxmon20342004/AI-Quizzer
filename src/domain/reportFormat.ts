import { gameName, t, type Lang } from "../i18n/index.js";
import type { GameType } from "./gameTypes.js";
import { rankRows, winners, type RankInput } from "./rules.js";
import { TG, escapeHtml } from "./telegramLimits.js";
import { formatLocalDate } from "./time.js";

export interface ReportRow extends RankInput {
  wrong: number;
  unanswered: number;
  pending: number;
  /** Streak bonus points included in `points`. */
  bonus: number;
}

export interface DailyReportData {
  lang: Lang;
  localDate: string;
  topic: string;
  gameType: GameType | null;
  rows: ReportRow[];
  inactive: ReportRow[];
  canceled: boolean;
}

export interface WeeklyReportData {
  lang: Lang;
  weekStart: string;
  weekEnd: string;
  rows: ReportRow[];
  inactive: ReportRow[];
}

export function rowLine(lang: Lang, r: ReportRow, rank?: number): string {
  const parts = [t(lang, "points", { n: r.points })];
  if (r.correct) parts.push(t(lang, "correct", { n: r.correct }));
  if (r.wrong) parts.push(t(lang, "wrong", { n: r.wrong }));
  if (r.unanswered) parts.push(t(lang, "unanswered", { n: r.unanswered }));
  if (r.pending) parts.push(t(lang, "pending", { n: r.pending }));
  const bonus = r.bonus ? ` 🔥+${r.bonus}` : "";
  const prefix = rank !== undefined ? `${rank}. ` : "";
  return `${prefix}<b>${escapeHtml(r.name)}</b>: ${parts.join(", ")}${bonus}`;
}

export function renderDailyReport(d: DailyReportData): string[] {
  const head = [`<b>${t(d.lang, "dailyTitle", { date: formatLocalDate(d.localDate) })}</b>`];
  if (d.topic) head.push(escapeHtml(t(d.lang, "topic", { topic: d.topic })));
  if (d.gameType) head.push(t(d.lang, "game", { game: gameName(d.lang, d.gameType) }));
  if (d.canceled) head.push(t(d.lang, "canceledNote"));

  const body = rankRows(d.rows).map(({ rank, row }) => rowLine(d.lang, row, rank));
  const tail: string[] = [];
  const bonuses = d.rows.filter((r) => r.bonus > 0);
  if (bonuses.length) {
    tail.push(`${t(d.lang, "bonus")}: ${bonuses.map((r) => `${escapeHtml(r.name)} +${r.bonus}`).join(", ")}`);
  }
  if (d.inactive.length) {
    tail.push("", `<i>${t(d.lang, "inactiveTitle")}</i>`, ...d.inactive.map((r) => rowLine(d.lang, r)));
  }
  if ([...d.rows, ...d.inactive].some((r) => r.pending > 0)) tail.push("", t(d.lang, "pendingNote"));
  return splitReport(d.lang, head, body, tail);
}

export function renderWeeklyReport(d: WeeklyReportData): { parts: string[]; provisional: boolean; winnerIds: number[] } {
  const head = [
    `<b>${t(d.lang, "weeklyTitle", { from: formatLocalDate(d.weekStart), to: formatLocalDate(d.weekEnd) })}</b>`,
  ];
  const ranked = rankRows(d.rows);
  const body = ranked.map(({ rank, row }) => rowLine(d.lang, row, rank));
  const provisional = [...d.rows, ...d.inactive].some((r) => r.pending > 0);
  const win = winners(ranked);
  const tail: string[] = [""];
  if (provisional) tail.push(t(d.lang, "provisionalNote"));
  else if (win.length === 0) tail.push(t(d.lang, "noChampion"));
  else {
    const names = win.map((w) => `<b>${escapeHtml(w.name)}</b>`).join(", ");
    tail.push(t(d.lang, win.length > 1 ? "champions" : "champion", { names }));
  }
  if (d.inactive.length) tail.push("", `<i>${t(d.lang, "inactiveTitle")}</i>`, ...d.inactive.map((r) => rowLine(d.lang, r)));
  return { parts: splitReport(d.lang, head, body, tail), provisional, winnerIds: provisional ? [] : win.map((w) => w.studentId) };
}

/**
 * Deterministic split into numbered parts below Telegram's message limit. The same data always yields the
 * same parts, so corrections can edit the existing messages part by part.
 */
export function splitReport(lang: Lang, head: string[], body: string[], tail: string[], max: number = TG.REPORT_PART_MAX): string[] {
  const lines = [...head, "", ...body, ...tail];
  const chunks: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const line of lines) {
    const add = line.length + 1;
    if (len + add > max && cur.length) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(line.length > max ? line.slice(0, max) : line);
    len += add;
  }
  if (cur.length) chunks.push(cur);
  if (chunks.length === 1) return [chunks[0]!.join("\n").trim()];
  return chunks.map((c, i) => `${t(lang, "part", { n: i + 1, total: chunks.length })}\n${c.join("\n").trim()}`);
}
