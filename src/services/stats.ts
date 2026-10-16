import { sql } from "kysely";
import type { Executor } from "../db/db.js";

export interface StudentPeriodStats {
  studentId: number;
  opportunities: number;
  answered: number;
  correct: number;
  wrong: number;
  pending: number;
}

/**
 * One batched query for all students of a group over the given day plans.
 * A question counts as an opportunity for a student only if it was validly delivered (closed, delivery
 * confirmed, not canceled/invalidated) and the student was eligible for its whole answer window - or the
 * student answered it anyway. Unanswered = opportunities - answered.
 */
export async function periodStats(ex: Executor, groupId: number, planIds: number[]): Promise<Map<number, StudentPeriodStats>> {
  const out = new Map<number, StudentPeriodStats>();
  if (!planIds.length) return out;
  const res = await sql<{ student_id: number; opportunities: number; answered: number; correct: number; wrong: number; pending: number }>`
    with valid as (
      select qi.id, coalesce(qi.opened_at, qi.publish_at) as opened_at, qi.close_at
      from question_instances qi
      where qi.day_plan_id = any(${planIds}::bigint[])
        and qi.state = 'closed' and qi.delivery_confirmed and qi.invalidated_at is null
    ),
    pairs as (
      select s.id as student_id, v.id as instance_id, ar.status,
        exists (
          select 1 from eligibility_intervals ei
          where ei.student_id = s.id and ei.starts_at <= v.opened_at
            and (ei.ends_at is null or ei.ends_at >= v.close_at)
        ) as eligible_window
      from students s
      cross join valid v
      left join answer_results ar on ar.instance_id = v.id and ar.student_id = s.id
      where s.group_id = ${groupId}
    )
    select student_id,
      count(*) filter (where eligible_window or status is not null)::int as opportunities,
      count(*) filter (where status is not null)::int as answered,
      count(*) filter (where status = 'correct')::int as correct,
      count(*) filter (where status = 'incorrect')::int as wrong,
      count(*) filter (where status in ('pending', 'needs_review'))::int as pending
    from pairs
    group by student_id`.execute(ex);
  for (const r of res.rows) {
    out.set(r.student_id, {
      studentId: r.student_id,
      opportunities: r.opportunities,
      answered: r.answered,
      correct: r.correct,
      wrong: r.wrong,
      pending: r.pending,
    });
  }
  return out;
}

export async function validInstanceCount(ex: Executor, planIds: number[]): Promise<number> {
  if (!planIds.length) return 0;
  const r = await ex
    .selectFrom("question_instances")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("day_plan_id", "in", planIds)
    .where("state", "=", "closed")
    .where("delivery_confirmed", "=", true)
    .where("invalidated_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}
