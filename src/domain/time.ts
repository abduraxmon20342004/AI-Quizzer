import { DateTime, IANAZone } from "luxon";

/** All instants are stored in UTC; calendar periods are computed in the group's timezone. */

export function isValidTimezone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

export function localDateOf(instant: Date, tz: string): string {
  return DateTime.fromJSDate(instant, { zone: tz }).toISODate()!;
}

/** ISO weekday 1 (Mon) .. 7 (Sun) of a local calendar date. */
export function weekdayOf(localDate: string): number {
  return DateTime.fromISO(localDate, { zone: "UTC" }).weekday;
}

export function addDays(localDate: string, days: number): string {
  return DateTime.fromISO(localDate, { zone: "UTC" }).plus({ days }).toISODate()!;
}

/** Monday of the week containing localDate (default week = Monday 00:00 .. next Monday 00:00). */
export function weekStartOf(localDate: string): string {
  const d = DateTime.fromISO(localDate, { zone: "UTC" });
  return d.minus({ days: d.weekday - 1 }).toISODate()!;
}

export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function parseHHMM(hhmm: string): { h: number; m: number; minutes: number } {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  return { h, m, minutes: h * 60 + m };
}

/** UTC instant for local date + wall-clock time in tz. */
export function atLocal(localDate: string, hhmm: string, tz: string): Date {
  const { h, m } = parseHHMM(hhmm);
  const dt = DateTime.fromISO(localDate, { zone: tz }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  return dt.toJSDate();
}

export function formatLocalTime(instant: Date, tz: string): string {
  return DateTime.fromJSDate(instant, { zone: tz }).toFormat("HH:mm");
}

export function formatLocalDate(localDate: string): string {
  return DateTime.fromISO(localDate, { zone: "UTC" }).toFormat("dd.MM.yyyy");
}

export function minutesToHHMM(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
