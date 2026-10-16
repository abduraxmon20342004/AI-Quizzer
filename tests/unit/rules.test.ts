import { describe, expect, it } from "vitest";
import { allocateDifficulties, pointsForCorrect, pointsSnapshot, rankRows, splitSourceExtra, streakBonusEarned, streakLength, winners } from "../../src/domain/rules.js";
import { defaultSettings } from "../../src/domain/settings.js";
import { resolveResult } from "../../src/services/scoring.js";

describe("80/20 lesson/extra split", () => {
  it("rounds the source count up for small batches", () => {
    expect(splitSourceExtra(6, 0.8)).toEqual({ source: 5, extra: 1 });
    expect(splitSourceExtra(10, 0.8)).toEqual({ source: 8, extra: 2 });
    expect(splitSourceExtra(5, 0.8)).toEqual({ source: 4, extra: 1 });
    expect(splitSourceExtra(3, 0.8)).toEqual({ source: 3, extra: 0 });
    expect(splitSourceExtra(1, 0.8)).toEqual({ source: 1, extra: 0 });
    expect(splitSourceExtra(4, 0)).toEqual({ source: 0, extra: 4 });
  });

  it("allocates the difficulty mix deterministically", () => {
    expect(allocateDifficulties(6, { easy: 2, medium: 3, hard: 1 })).toEqual(["easy", "easy", "medium", "medium", "medium", "hard"]);
    expect(allocateDifficulties(4, { easy: 0, medium: 1, hard: 0 })).toEqual(["medium", "medium", "medium", "medium"]);
  });
});

describe("points", () => {
  const p = defaultSettings().points;
  it("uses difficulty points, fixed true/false and emoji points, and stage rewards for guess the word", () => {
    expect(pointsForCorrect(pointsSnapshot("quiz_poll", "easy", p))).toBe(5);
    expect(pointsForCorrect(pointsSnapshot("picture_quiz", "medium", p))).toBe(10);
    expect(pointsForCorrect(pointsSnapshot("find_mistake", "hard", p))).toBe(15);
    expect(pointsForCorrect(pointsSnapshot("true_false", "hard", p))).toBe(5);
    expect(pointsForCorrect(pointsSnapshot("emoji_puzzle", "hard", p))).toBe(5);
    const gw = pointsSnapshot("guess_word", "hard", p);
    expect([1, 2, 3].map((st) => pointsForCorrect(gw, st))).toEqual([15, 10, 5]);
  });

  it("resolves guess-the-word by the earliest correct stage; an earlier pending guess keeps it pending", () => {
    expect(resolveResult("guess_word", [{ id: 1, stage: 1, verdict: "incorrect" }, { id: 2, stage: 2, verdict: "correct" }])).toMatchObject({ status: "correct", stage: 2 });
    expect(resolveResult("guess_word", [{ id: 1, stage: 1, verdict: "pending" }, { id: 2, stage: 2, verdict: "correct" }])).toMatchObject({ status: "pending", stage: 1 });
    expect(resolveResult("guess_word", [{ id: 2, stage: 2, verdict: "correct" }, { id: 1, stage: 1, verdict: "correct" }])).toMatchObject({ status: "correct", stage: 1 });
    expect(resolveResult("guess_word", [{ id: 1, stage: 1, verdict: "incorrect" }, { id: 2, stage: 3, verdict: "incorrect" }])).toMatchObject({ status: "incorrect" });
  });
});

describe("streaks", () => {
  it("counts consecutive qualifying game days; neutral days are skipped, missed days break", () => {
    expect(streakLength(["qualified", "qualified", "neutral", "qualified"])).toBe(3);
    expect(streakLength(["qualified", "missed", "qualified"])).toBe(1);
    expect(streakLength(["neutral", "neutral"])).toBe(0);
  });

  it("awards at 5, 10, 15 qualifying days only", () => {
    const days = Array.from({ length: 15 }, () => "qualified" as const);
    const awarded = days.map((_, i) => streakBonusEarned(days.slice(0, i + 1), 5)).filter(Boolean);
    expect(awarded).toEqual([5, 10, 15]);
    expect(streakBonusEarned(["qualified", "qualified", "qualified", "qualified", "neutral"], 5)).toBeNull();
    expect(streakBonusEarned(["qualified", "qualified", "neutral", "qualified", "qualified", "qualified"], 5)).toBe(5);
  });
});

describe("ranking", () => {
  it("ranks by points then correct answers; full ties share rank and the title", () => {
    const ranked = rankRows([
      { studentId: 1, name: "Ali", points: 50, correct: 5 },
      { studentId: 2, name: "Madina", points: 50, correct: 5 },
      { studentId: 3, name: "Umar", points: 50, correct: 4 },
      { studentId: 4, name: "Zarina", points: 10, correct: 1 },
    ]);
    expect(ranked.map((r) => [r.row.name, r.rank])).toEqual([
      ["Ali", 1],
      ["Madina", 1],
      ["Umar", 3],
      ["Zarina", 4],
    ]);
    expect(winners(ranked).map((w) => w.name)).toEqual(["Ali", "Madina"]);
  });

  it("names no champion when nobody scored", () => {
    expect(winners(rankRows([{ studentId: 1, name: "A", points: 0, correct: 0 }]))).toEqual([]);
  });
});
