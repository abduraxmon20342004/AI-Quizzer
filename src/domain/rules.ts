import type { Difficulty, GameType } from "./gameTypes.js";
import type { GroupSettings } from "./settings.js";

/**
 * Lesson-grounded vs extra split. The source count rounds UP so small batches stay lesson-heavy:
 * 6 questions at 80% -> 5 source + 1 extra.
 */
export function splitSourceExtra(total: number, sourceRatio: number): { source: number; extra: number } {
  if (total <= 0) return { source: 0, extra: 0 };
  const source = Math.min(total, Math.max(0, Math.ceil(total * sourceRatio - 1e-9)));
  return { source, extra: total - source };
}

/** Deterministic largest-remainder allocation of n questions across the difficulty weights. */
export function allocateDifficulties(n: number, mix: GroupSettings["difficultyMix"]): Difficulty[] {
  const order: Difficulty[] = ["easy", "medium", "hard"];
  const total = mix.easy + mix.medium + mix.hard;
  if (n <= 0) return [];
  if (total === 0) return Array.from({ length: n }, () => "medium");
  const exact = order.map((d) => (n * mix[d]) / total);
  const counts = exact.map(Math.floor);
  let left = n - counts.reduce((a, b) => a + b, 0);
  const byRemainder = order
    .map((d, i) => ({ i, r: exact[i]! - counts[i]! }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of byRemainder) {
    if (left <= 0) break;
    counts[i]!++;
    left--;
  }
  const out: Difficulty[] = [];
  order.forEach((d, i) => {
    for (let k = 0; k < counts[i]!; k++) out.push(d);
  });
  return out;
}

/** Points snapshot frozen on a question instance when it is published. */
export interface PointsSnapshot {
  /** Points for a correct answer (non-staged games). */
  correct: number;
  /** Guess-the-word: reward per clue stage (1-based index -> points). */
  stages?: [number, number, number];
}

export function pointsSnapshot(gameType: GameType, difficulty: Difficulty, p: GroupSettings["points"]): PointsSnapshot {
  switch (gameType) {
    case "true_false":
      return { correct: p.trueFalse };
    case "emoji_puzzle":
      return { correct: p.emoji };
    case "guess_word":
      return { correct: p.guessStages[0], stages: [...p.guessStages] };
    default:
      return { correct: p[difficulty] };
  }
}

/** Points for a correct answer; the AI never chooses points, the verdict is mapped here. */
export function pointsForCorrect(snapshot: PointsSnapshot, stage = 1): number {
  if (snapshot.stages) return snapshot.stages[Math.min(Math.max(stage, 1), 3) - 1] ?? 0;
  return snapshot.correct;
}

// ---------- streaks ----------

export type DayStatus = "qualified" | "missed" | "neutral";

/**
 * Streak length ending at the last element. Neutral days (no valid question, day off, canceled day, student
 * blocked all day) neither extend nor break it; a missed day breaks it.
 */
export function streakLength(days: DayStatus[]): number {
  let len = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i];
    if (d === "neutral") continue;
    if (d === "missed") break;
    len++;
  }
  return len;
}

/** A bonus is earned on the qualifying day that makes the streak a multiple of `every`. */
export function streakBonusEarned(days: DayStatus[], every: number): number | null {
  if (days.length === 0 || days[days.length - 1] !== "qualified") return null;
  const len = streakLength(days);
  return len > 0 && len % every === 0 ? len : null;
}

// ---------- ranking ----------

export interface RankInput {
  studentId: number;
  name: string;
  points: number;
  correct: number;
}

export interface Ranked<T extends RankInput> {
  rank: number;
  row: T;
}

/**
 * Rank by total points, then correct-answer count. Equal points and correct counts share a rank
 * (competition ranking 1,1,3). No speed or hidden tie-breaker; names only order the display of ties.
 */
export function rankRows<T extends RankInput>(rows: T[]): Ranked<T>[] {
  const sorted = [...rows].sort(
    (a, b) => b.points - a.points || b.correct - a.correct || a.name.localeCompare(b.name) || a.studentId - b.studentId,
  );
  const out: Ranked<T>[] = [];
  sorted.forEach((row, i) => {
    const prev = out[i - 1];
    const tied = prev && prev.row.points === row.points && prev.row.correct === row.correct;
    out.push({ rank: tied ? prev.rank : i + 1, row });
  });
  return out;
}

/** Winners share the title on a full tie; nobody wins with zero points. */
export function winners<T extends RankInput>(ranked: Ranked<T>[]): T[] {
  return ranked.filter((r) => r.rank === 1 && r.row.points > 0).map((r) => r.row);
}
