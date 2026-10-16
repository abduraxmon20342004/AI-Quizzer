import { describe, expect, it } from "vitest";
import { computeSlots, dayEnd, maxQuestionsThatFit, validateSettings, weeklyReportDueAt } from "../../src/domain/schedule.js";
import { defaultSettings, gameForWeekday } from "../../src/domain/settings.js";
import { localDateOf, weekStartOf, weekdayOf } from "../../src/domain/time.js";

const s = defaultSettings();

describe("schedule", () => {
  it("computes the documented example: 18:00-21:00, six questions every 30 min, 10-minute windows", () => {
    const slots = computeSlots(s, "2026-10-19");
    const local = slots.map((x) => x.publishAt.toLocaleTimeString("en-GB", { timeZone: "Asia/Tashkent", hour: "2-digit", minute: "2-digit" }));
    expect(local).toEqual(["18:00", "18:30", "19:00", "19:30", "20:00", "20:30"]);
    expect(slots.every((x) => x.closeAt.getTime() - x.publishAt.getTime() === 600_000)).toBe(true);
    expect(dayEnd(s, "2026-10-19").toISOString()).toBe("2026-10-19T16:00:00.000Z"); // 21:00 Tashkent (UTC+5)
    // Guess-the-word clue stages at one third and two thirds of the window.
    expect(slots[0]!.clueAt.map((d) => (d.getTime() - slots[0]!.publishAt.getTime()) / 1000)).toEqual([200, 400]);
  });

  it("accepts the default settings", () => {
    expect(validateSettings(s)).toEqual([]);
  });

  it("rejects overnight windows with an explanation", () => {
    const errs = validateSettings({ ...s, startTime: "22:00", endTime: "01:00" });
    expect(errs.join()).toMatch(/Yarim tundan/);
  });

  it("rejects schedules where the questions do not fit, saying how many fit", () => {
    const bad = { ...s, questionsPerDay: 8 };
    expect(maxQuestionsThatFit(bad)).toBe(6);
    expect(validateSettings(bad).join()).toMatch(/ko'pi bilan 6 ta savol/);
  });

  it("rejects overlapping questions by default", () => {
    expect(validateSettings({ ...s, answerSeconds: 40 * 60 }).join()).toMatch(/ustma-ust/);
  });

  it("requires enough time for three guess-the-word clues", () => {
    expect(validateSettings({ ...s, answerSeconds: 120, spacingMinutes: 30 }).join()).toMatch(/kamida 3 daqiqa/);
  });

  it("rejects a weekly report that would be announced before the last game of the week", () => {
    expect(validateSettings({ ...s, weeklyReport: { day: 5, time: "18:00" } }).join()).toMatch(/Haftalik hisobot/);
    expect(validateSettings({ ...s, weeklyReport: { day: 6, time: "20:00" } }).join()).toMatch(/tugashidan/);
    expect(validateSettings({ ...s, weeklyReport: { day: 6, time: "21:30" } })).toEqual([]);
  });

  it("maps weekdays to the default game types; Sunday is report-only", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => gameForWeekday(s, d))).toEqual([
      "quiz_poll",
      "find_mistake",
      "guess_word",
      "true_false",
      "picture_quiz",
      "emoji_puzzle",
      null,
    ]);
  });

  it("uses the group's timezone for calendar days and Monday-based weeks", () => {
    // 2026-10-18T20:30Z is already Monday 01:30 in Tashkent.
    expect(localDateOf(new Date("2026-10-18T20:30:00Z"), "Asia/Tashkent")).toBe("2026-10-19");
    expect(weekdayOf("2026-10-19")).toBe(1);
    expect(weekStartOf("2026-10-25")).toBe("2026-10-19");
    expect(weekStartOf("2026-10-26")).toBe("2026-10-26");
    expect(weeklyReportDueAt(s, "2026-10-19").toISOString()).toBe("2026-10-25T13:00:00.000Z");
  });
});
