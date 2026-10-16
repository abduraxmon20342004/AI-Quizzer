import { sql } from "kysely";
import type { AppContext } from "../app/context.js";
import type { Executor } from "../db/db.js";
import type { Verdict } from "../db/schema.js";
import { pointsForCorrect, type PointsSnapshot } from "../domain/rules.js";
import { weekStartOf } from "../domain/time.js";
import { markReportsStale } from "./reportsStale.js";

/**
 * Points live in an append-only ledger. The desired points for (question, student) are derived from the
 * result; reconcilePairPoints appends exactly the difference. Re-running it is a no-op, so duplicate
 * Telegram updates, job retries, crashes or report reruns can never award twice. Corrections append
 * adjustment/reversal entries; history is never overwritten.
 */
export async function reconcilePairPoints(
  ex: Executor,
  a: { groupId: number; instanceId: number; studentId: number; localDate: string; desired: number; reason: string; actorId?: number | null },
): Promise<number> {
  const agg = await ex
    .selectFrom("score_ledger")
    .select([sql<number>`coalesce(sum(points), 0)::int`.as("total"), sql<number>`count(*)::int`.as("n")])
    .where("instance_id", "=", a.instanceId)
    .where("student_id", "=", a.studentId)
    .executeTakeFirstOrThrow();
  const delta = a.desired - agg.total;
  if (delta === 0) return 0;
  const first = agg.n === 0;
  await ex
    .insertInto("score_ledger")
    .values({
      group_id: a.groupId,
      student_id: a.studentId,
      points: delta,
      kind: first ? "answer" : a.desired === 0 ? "reversal" : "adjustment",
      award_key: first ? `answer:${a.instanceId}:${a.studentId}` : `answer:${a.instanceId}:${a.studentId}:${agg.n}`,
      instance_id: a.instanceId,
      local_date: a.localDate,
      week_start: weekStartOf(a.localDate),
      reason: a.reason,
      actor_id: a.actorId ?? null,
    })
    .execute();
  return delta;
}

interface SubRow {
  id: number;
  stage: number;
  verdict: Verdict;
}

/**
 * Resolve one student's result for one question.
 * Guess the word: guesses are evaluated in stage order. The earliest correct stage wins; a pending earlier
 * guess keeps the result pending (a delayed AI verdict for stage 1 can never lose to a later stage).
 */
export function resolveResult(gameType: string, subs: SubRow[]): { status: Verdict; submissionId: number | null; stage: number | null } {
  if (subs.length === 0) return { status: "incorrect", submissionId: null, stage: null };
  const ordered = [...subs].sort((a, b) => a.stage - b.stage || a.id - b.id);
  if (gameType !== "guess_word") {
    const s = ordered[0]!;
    return { status: s.verdict, submissionId: s.id, stage: s.stage };
  }
  for (const s of ordered) {
    if (s.verdict === "pending" || s.verdict === "needs_review") return { status: s.verdict, submissionId: s.id, stage: s.stage };
    if (s.verdict === "correct") return { status: "correct", submissionId: s.id, stage: s.stage };
  }
  const last = ordered[ordered.length - 1]!;
  return { status: "incorrect", submissionId: last.id, stage: last.stage };
}

/** Recompute the result row and reconcile ledger points for (instance, student). Serialized by a row lock. */
export async function recomputeResult(ctx: AppContext, ex: Executor, instanceId: number, studentId: number, reason = "answer", actorId: number | null = null): Promise<void> {
  const inst = await ex
    .selectFrom("question_instances as qi")
    .innerJoin("day_plans as dp", "dp.id", "qi.day_plan_id")
    .select(["qi.id", "qi.group_id", "qi.game_type", "qi.state", "qi.points", "qi.invalidated_at", "dp.local_date"])
    .where("qi.id", "=", instanceId)
    .executeTakeFirstOrThrow();
  const subs = await ex
    .selectFrom("submissions")
    .select(["id", "stage", "verdict"])
    .where("instance_id", "=", instanceId)
    .where("student_id", "=", studentId)
    .execute();
  if (subs.length === 0) return;
  const r = resolveResult(inst.game_type, subs);

  // Lock (or create) the result row so concurrent graders of the same pair serialize.
  await ex
    .insertInto("answer_results")
    .values({ instance_id: instanceId, student_id: studentId, group_id: inst.group_id, local_date: inst.local_date, status: r.status, final_submission_id: r.submissionId, stage: r.stage })
    .onConflict((oc) => oc.columns(["instance_id", "student_id"]).doNothing())
    .execute();
  const prev = await ex
    .selectFrom("answer_results")
    .selectAll()
    .where("instance_id", "=", instanceId)
    .where("student_id", "=", studentId)
    .forUpdate()
    .executeTakeFirstOrThrow();

  const valid = !inst.invalidated_at && inst.state !== "canceled";
  const snapshot = (inst.points ?? { correct: 0 }) as PointsSnapshot;
  const desired = valid && r.status === "correct" ? pointsForCorrect(snapshot, r.stage ?? 1) : 0;

  if (prev.status !== r.status || prev.final_submission_id !== r.submissionId || prev.stage !== r.stage || prev.points !== desired) {
    await ex
      .updateTable("answer_results")
      .set({ status: r.status, final_submission_id: r.submissionId, stage: r.stage, points: desired, updated_at: ctx.clock.now() })
      .where("instance_id", "=", instanceId)
      .where("student_id", "=", studentId)
      .execute();
  }
  const delta = await reconcilePairPoints(ex, {
    groupId: inst.group_id,
    instanceId,
    studentId,
    localDate: inst.local_date,
    desired,
    reason,
    actorId,
  });
  if (delta !== 0 || prev.status !== r.status) await markReportsStale(ex, inst.group_id, inst.local_date);
}

/**
 * Invalidate a question (Stop Today on the active question, or an admin invalidation): its points are
 * reversed through ledger entries, it no longer counts for streaks/accuracy, and reports are refreshed.
 */
export async function invalidateInstance(ctx: AppContext, ex: Executor, instanceId: number, actorId: number | null, reason: string): Promise<void> {
  const now = ctx.clock.now();
  const inst = await ex
    .updateTable("question_instances")
    .set({ invalidated_at: now, invalidated_by: actorId, state_reason: reason, updated_at: now })
    .where("id", "=", instanceId)
    .where("invalidated_at", "is", null)
    .returning(["id", "group_id"])
    .executeTakeFirst();
  if (!inst) return;
  const students = await ex.selectFrom("answer_results").select("student_id").where("instance_id", "=", instanceId).execute();
  for (const s of students) await recomputeResult(ctx, ex, instanceId, s.student_id, `invalidated: ${reason}`, actorId);
  await ex
    .insertInto("audit_events")
    .values({ group_id: inst.group_id, actor_id: actorId, action: "question.invalidate", details: JSON.stringify({ instanceId, reason }) })
    .execute();
}
