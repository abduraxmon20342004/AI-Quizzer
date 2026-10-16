import { sql } from "kysely";
import type { AppContext } from "../app/context.js";
import type { Executor } from "../db/db.js";
import type { ReviewStatus, Row } from "../db/schema.js";
import type { QuestionDraft } from "../domain/content.js";
import type { GameType } from "../domain/gameTypes.js";
import { allocateDifficulties, splitSourceExtra } from "../domain/rules.js";
import { addDays } from "../domain/time.js";
import { audit } from "./audit.js";
import { getSettings } from "./groups.js";

/** Store a generated draft as a new question (or a new version of an existing question). */
export async function storeVersion(
  ex: Executor,
  v: {
    groupId: number;
    batchId: number | null;
    draft: QuestionDraft;
    content: Record<string, unknown>;
    contentHash: string;
    searchText: string;
    status: ReviewStatus;
    errors: string[];
    attempt: number;
    questionId?: number;
  },
): Promise<Row<"question_versions">> {
  let questionId = v.questionId;
  let version = 1;
  if (questionId) {
    const last = await ex.selectFrom("question_versions").select(sql<number>`max(version)::int`.as("v")).where("question_id", "=", questionId).executeTakeFirst();
    version = (last?.v ?? 0) + 1;
  } else {
    const q = await ex
      .insertInto("questions")
      .values({ group_id: v.groupId, game_type: v.draft.gameType, origin: v.draft.origin, batch_id: v.batchId })
      .returning("id")
      .executeTakeFirstOrThrow();
    questionId = q.id;
  }
  const row = await ex
    .insertInto("question_versions")
    .values({
      question_id: questionId,
      group_id: v.groupId,
      version,
      game_type: v.draft.gameType,
      language: v.draft.language,
      difficulty: v.draft.difficulty,
      origin: v.draft.origin,
      content: JSON.stringify(v.content),
      source_refs: JSON.stringify(v.draft.sourceRefs),
      source_excerpt: v.draft.sourceExcerpt,
      content_hash: v.contentHash,
      search_text: v.searchText,
      review_status: v.status,
      validation_errors: JSON.stringify(v.errors),
      attempt: v.attempt,
      ...(v.status === "rejected" ? { rejected_reason: "deterministic validation" } : {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await ex.updateTable("questions").set({ current_version_id: row.id }).where("id", "=", questionId).execute();
  return row;
}

/** Content hashes and texts used for duplicate checks: bank items plus questions used recently. */
export async function duplicateCorpus(ex: Executor, groupId: number, recentDays: number, now: Date): Promise<{ hash: string; text: string }[]> {
  const since = new Date(now.getTime() - recentDays * 86_400_000);
  const rows = await ex
    .selectFrom("question_versions as v")
    .select(["v.content_hash as hash", "v.search_text as text"])
    .where("v.group_id", "=", groupId)
    .where((eb) =>
      eb.or([
        eb("v.review_status", "in", ["draft", "validated", "approved"]),
        eb.exists(
          eb
            .selectFrom("question_instances as qi")
            .select("qi.id")
            .whereRef("qi.question_version_id", "=", "v.id")
            .where("qi.publish_at", ">=", since),
        ),
      ]),
    )
    .execute();
  return rows;
}

export async function approveVersion(ctx: AppContext, ex: Executor, versionId: number, actorId: number): Promise<boolean> {
  const res = await ex
    .updateTable("question_versions")
    .set({ review_status: "approved", approved_by: actorId, approved_at: ctx.clock.now() })
    .where("id", "=", versionId)
    .where("review_status", "in", ["validated", "draft"])
    .returning(["group_id"])
    .executeTakeFirst();
  if (res) await audit(ex, res.group_id, actorId, "question.approve", { versionId });
  return !!res;
}

export async function rejectVersion(ctx: AppContext, ex: Executor, versionId: number, actorId: number, reason: string): Promise<boolean> {
  const res = await ex
    .updateTable("question_versions")
    .set({ review_status: "rejected", rejected_reason: reason })
    .where("id", "=", versionId)
    .where("review_status", "in", ["validated", "draft", "approved"])
    .where("published_at", "is", null)
    .returning(["group_id"])
    .executeTakeFirst();
  if (!res) return false;
  // Unpublished slots that were holding this version get a fresh assignment later.
  await ex.updateTable("question_instances").set({ question_version_id: null }).where("question_version_id", "=", versionId).where("state", "=", "scheduled").execute();
  await audit(ex, res.group_id, actorId, "question.reject", { versionId, reason });
  return true;
}

export interface BankStats {
  type: GameType;
  approvedFree: number;
  awaitingReview: number;
}

export async function bankStats(ex: Executor, groupId: number): Promise<BankStats[]> {
  const rows = await ex
    .selectFrom("question_versions as v")
    .innerJoin("questions as q", (j) => j.onRef("q.current_version_id", "=", "v.id"))
    .select([
      "v.game_type",
      sql<number>`count(*) filter (where v.review_status = 'approved' and v.published_at is null and not exists (select 1 from question_instances qi where qi.question_version_id = v.id and qi.state = 'scheduled'))::int`.as("free"),
      sql<number>`count(*) filter (where v.review_status = 'validated')::int`.as("review"),
    ])
    .where("v.group_id", "=", groupId)
    .groupBy("v.game_type")
    .execute();
  return rows.map((r) => ({ type: r.game_type as GameType, approvedFree: r.free, awaitingReview: r.review }));
}

/**
 * Assign approved questions to the unassigned scheduled slots of a day plan:
 * - only the plan's (frozen) game type, only approved current versions of this group
 * - no question used in the last `recentRepeatDays` days or already assigned to another slot
 * - aims for the source/extra split (rounded up) and the difficulty mix (easy -> hard through the day)
 * - picture questions only with an approved picture asset
 */
export async function assignPlan(ctx: AppContext, ex: Executor, planId: number): Promise<{ assigned: number; missing: number }> {
  const plan = await ex.selectFrom("day_plans").selectAll().where("id", "=", planId).executeTakeFirstOrThrow();
  if (!plan.game_type || ["finished", "canceled", "off"].includes(plan.status)) return { assigned: 0, missing: 0 };
  const settings = await getSettings(ctx, ex, plan.group_id);
  const all = await ex
    .selectFrom("question_instances as qi")
    .leftJoin("question_versions as v", "v.id", "qi.question_version_id")
    .select(["qi.id", "qi.slot", "qi.state", "qi.question_version_id", "v.origin", "v.difficulty"])
    .where("qi.day_plan_id", "=", planId)
    .where("qi.state", "not in", ["canceled", "skipped"])
    .orderBy("qi.slot")
    .execute();
  const open = all.filter((i) => i.state === "scheduled" && !i.question_version_id);
  if (!open.length) return { assigned: 0, missing: 0 };

  const n = all.length;
  const { source: sourceTarget } = splitSourceExtra(n, settings.sourceRatio);
  const difficulties = allocateDifficulties(n, settings.difficultyMix);
  let sourceUsed = all.filter((i) => i.question_version_id && i.origin === "source").length;

  const since = addDays(plan.local_date, -settings.recentRepeatDays);
  const candidates = await ex
    .selectFrom("question_versions as v")
    .innerJoin("questions as q", (j) => j.onRef("q.current_version_id", "=", "v.id"))
    .select(["v.id", "v.question_id", "v.origin", "v.difficulty", "v.content", "v.approved_at"])
    .where("v.group_id", "=", plan.group_id)
    .where("v.game_type", "=", plan.game_type)
    .where("v.review_status", "=", "approved")
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("question_instances as qi")
            .innerJoin("question_versions as v2", "v2.id", "qi.question_version_id")
            .innerJoin("day_plans as dp", "dp.id", "qi.day_plan_id")
            .select("qi.id")
            .whereRef("v2.question_id", "=", "v.question_id")
            .where("qi.state", "not in", ["canceled", "skipped"])
            .where((e2) => e2.or([e2("qi.state", "=", "scheduled"), e2("dp.local_date", ">=", since)])),
        ),
      ),
    )
    .orderBy("v.approved_at")
    .orderBy("v.id")
    .execute();

  let usable = candidates;
  if (plan.game_type === "picture_quiz") {
    const assets = new Set(
      (await ex.selectFrom("picture_assets").select("id").where("group_id", "=", plan.group_id).where("status", "=", "approved").execute()).map((a) => a.id),
    );
    usable = candidates.filter((c) => assets.has(Number((c.content as { assetId?: number }).assetId)));
  }

  let assigned = 0;
  const taken = new Set<number>();
  for (const slot of open) {
    const wantOrigin = sourceUsed < sourceTarget ? "source" : "extra";
    const wantDifficulty = difficulties[slot.slot] ?? "medium";
    let best: (typeof usable)[number] | undefined;
    let bestScore = -1;
    for (const c of usable) {
      if (taken.has(c.question_id)) continue;
      const score = (c.origin === wantOrigin ? 2 : 0) + (c.difficulty === wantDifficulty ? 1 : 0);
      if (score > bestScore) {
        best = c;
        bestScore = score;
        if (score === 3) break;
      }
    }
    if (!best) continue;
    taken.add(best.question_id);
    if (best.origin === "source") sourceUsed++;
    await ex.updateTable("question_instances").set({ question_version_id: best.id, updated_at: ctx.clock.now() }).where("id", "=", slot.id).where("state", "=", "scheduled").execute();
    assigned++;
  }
  return { assigned, missing: open.length - assigned };
}
