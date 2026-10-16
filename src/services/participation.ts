import { sql } from "kysely";
import type { AppContext } from "../app/context.js";
import type { Executor } from "../db/db.js";
import { streakBonusEarned, type DayStatus } from "../domain/rules.js";
import { weekStartOf } from "../domain/time.js";
import { getSettings } from "./groups.js";
import { markReportsStale } from "./reportsStale.js";
import { periodStats, validInstanceCount } from "./stats.js";

/**
 * Daily participation: a scheduled game day counts when the student submitted at least one timely answer to
 * a valid, non-canceled question (even a wrong or still-pending one). Days without valid delivered
 * questions, canceled days, or days the student was ineligible for all questions are neutral. An eligible
 * student with an opportunity but no answer has a missed day (breaks the streak).
 * Records are immutable: a recalculation supersedes the previous row.
 */
export async function computeDayParticipation(ctx: AppContext, ex: Executor, groupId: number, planId: number, localDate: string): Promise<boolean> {
  const now = ctx.clock.now();
  const valid = await validInstanceCount(ex, [planId]);
  const stats = await periodStats(ex, groupId, [planId]);
  const current = await ex
    .selectFrom("daily_participation")
    .selectAll()
    .where("group_id", "=", groupId)
    .where("local_date", "=", localDate)
    .where("superseded_at", "is", null)
    .execute();
  const byStudent = new Map(current.map((r) => [r.student_id, r]));
  // Every student gets a record - with no valid questions the stats are empty and the day is neutral.
  const students = await ex.selectFrom("students").select("id").where("group_id", "=", groupId).execute();
  let changed = false;
  for (const { id } of students) {
    const st = stats.get(id) ?? { studentId: id, opportunities: 0, answered: 0, correct: 0, wrong: 0, pending: 0 };
    const status: DayStatus = valid === 0 || st.opportunities === 0 ? "neutral" : st.answered > 0 ? "qualified" : "missed";
    const prev = byStudent.get(st.studentId);
    if (prev && prev.status === status && prev.opportunities === st.opportunities && prev.answered === st.answered) continue;
    if (prev) await ex.updateTable("daily_participation").set({ superseded_at: now }).where("id", "=", prev.id).execute();
    await ex
      .insertInto("daily_participation")
      .values({ group_id: groupId, student_id: st.studentId, local_date: localDate, status, opportunities: st.opportunities, answered: st.answered, computed_at: now })
      .execute();
    changed = true;
  }
  return changed;
}

/**
 * Streak bonuses from `fromDate` onwards: +bonus on the qualifying day that makes the streak a multiple of
 * `every`. Each award has an idempotent ledger key; awards that become invalid after a correction are
 * revoked through audited reversal entries.
 */
export async function applyStreakBonuses(ctx: AppContext, ex: Executor, groupId: number, fromDate: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`streak:${groupId}`}))`.execute(ex);
  const s = await getSettings(ctx, ex, groupId);
  const rows = await ex
    .selectFrom("daily_participation")
    .select(["student_id", "local_date", "status"])
    .where("group_id", "=", groupId)
    .where("superseded_at", "is", null)
    .orderBy("student_id")
    .orderBy("local_date")
    .execute();
  const history = new Map<number, { date: string; status: DayStatus }[]>();
  for (const r of rows) {
    const list = history.get(r.student_id) ?? [];
    list.push({ date: r.local_date, status: r.status });
    history.set(r.student_id, list);
  }
  const existing = await ex
    .selectFrom("streak_awards")
    .selectAll()
    .where("group_id", "=", groupId)
    .where("local_date", ">=", fromDate)
    .where("revoked_at", "is", null)
    .execute();
  const existingKey = new Map(existing.map((a) => [`${a.student_id}|${a.local_date}`, a]));
  const desired = new Map<string, { studentId: number; date: string; len: number }>();
  if (s.streak.enabled) {
    for (const [studentId, days] of history) {
      const statuses: DayStatus[] = [];
      for (const d of days) {
        statuses.push(d.status);
        if (d.date < fromDate) continue;
        const len = streakBonusEarned(statuses, s.streak.every);
        if (len) desired.set(`${studentId}|${d.date}`, { studentId, date: d.date, len });
      }
    }
  }
  const touched = new Set<string>();
  const now = ctx.clock.now();
  for (const [key, award] of existingKey) {
    const want = desired.get(key);
    if (want && want.len === award.streak_length) continue;
    if (!want && !s.streak.enabled) continue; // disabling streaks later never claws back earned bonuses
    const original = await ex.selectFrom("score_ledger").select(["points"]).where("id", "=", award.ledger_id).executeTakeFirstOrThrow();
    const rev = await ex
      .insertInto("score_ledger")
      .values({
        group_id: groupId,
        student_id: award.student_id,
        points: -original.points,
        kind: "reversal",
        award_key: `streak-revoke:${award.id}`,
        local_date: award.local_date,
        week_start: weekStartOf(award.local_date),
        reason: "streak recalculated after a correction",
        reverses_id: award.ledger_id,
      })
      .onConflict((oc) => oc.column("award_key").doNothing())
      .returning("id")
      .executeTakeFirst();
    await ex.updateTable("streak_awards").set({ revoked_at: now, revoke_ledger_id: rev?.id ?? null }).where("id", "=", award.id).execute();
    touched.add(award.local_date);
  }
  for (const [key, want] of desired) {
    const have = existingKey.get(key);
    if (have && have.streak_length === want.len) continue;
    const prior = await ex
      .selectFrom("streak_awards")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("group_id", "=", groupId)
      .where("student_id", "=", want.studentId)
      .where("local_date", "=", want.date)
      .executeTakeFirstOrThrow();
    const ledger = await ex
      .insertInto("score_ledger")
      .values({
        group_id: groupId,
        student_id: want.studentId,
        points: s.streak.bonus,
        kind: "streak_bonus",
        award_key: `streak:${groupId}:${want.studentId}:${want.date}:${Number(prior.n)}`,
        local_date: want.date,
        week_start: weekStartOf(want.date),
        reason: `${want.len}-day streak`,
      })
      .onConflict((oc) => oc.column("award_key").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (!ledger) continue;
    await ex.insertInto("streak_awards").values({ group_id: groupId, student_id: want.studentId, local_date: want.date, streak_length: want.len, ledger_id: ledger.id }).execute();
    touched.add(want.date);
  }
  for (const d of touched) await markReportsStale(ex, groupId, d);
}

/** After a correction on a past day: recompute that day's participation and every streak from there on. */
export async function recalcFromDate(ctx: AppContext, ex: Executor, groupId: number, localDate: string): Promise<void> {
  const plans = await ex
    .selectFrom("day_plans")
    .select(["id", "local_date"])
    .where("group_id", "=", groupId)
    .where("local_date", ">=", localDate)
    .where("status", "=", "finished")
    .orderBy("local_date")
    .execute();
  for (const p of plans) await computeDayParticipation(ctx, ex, groupId, p.id, p.local_date);
  if (plans.length) await applyStreakBonuses(ctx, ex, groupId, localDate);
}
