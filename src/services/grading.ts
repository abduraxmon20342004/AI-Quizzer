import { createHmac } from "node:crypto";
import type { AppContext } from "../app/context.js";
import { buildGradeRequest } from "../ai/grader.js";
import { PROMPT_VERSION } from "../ai/prompts.js";
import { AiPermanentError } from "../ai/provider.js";
import { AiBudgetExceeded, runAi } from "../ai/run.js";
import type { GradeOutput } from "../ai/schemas.js";
import type { Executor } from "../db/db.js";
import type { Verdict } from "../db/schema.js";
import { parseContent, type ContentOf } from "../domain/content.js";
import type { GameType } from "../domain/gameTypes.js";
import { codeKey, normalizeWord } from "../domain/normalize.js";
import { hashContent, sha256 } from "../domain/similarity.js";
import { audit } from "./audit.js";
import { getSettings } from "./groups.js";
import { recalcFromDate } from "./participation.js";
import { recomputeResult } from "./scoring.js";

/** Store a verdict (append-only decision history) and recompute the result and points. */
export async function applyVerdict(
  ctx: AppContext,
  ex: Executor,
  a: { submissionId: number; verdict: Verdict; method: "ai" | "admin" | "system"; reason: string; model?: string; cacheKey?: string; actorId?: number | null },
): Promise<void> {
  const sub = await ex.selectFrom("submissions").selectAll().where("id", "=", a.submissionId).forUpdate().executeTakeFirstOrThrow();
  await ex
    .updateTable("submissions")
    .set({ verdict: a.verdict, graded_by: a.method === "system" ? null : a.method, grading_reason: a.reason.slice(0, 500), graded_at: ctx.clock.now() })
    .where("id", "=", sub.id)
    .execute();
  await ex
    .insertInto("grading_decisions")
    .values({ submission_id: sub.id, method: a.method, verdict: a.verdict, reason: a.reason.slice(0, 500), model: a.model ?? null, cache_key: a.cacheKey ?? null, actor_id: a.actorId ?? null })
    .execute();
  await recomputeResult(ctx, ex, sub.instance_id, sub.student_id, a.method === "admin" ? `admin: ${a.reason}` : `graded (${a.method})`, a.actorId ?? null);
}

/**
 * AI grading job for one free-text submission. Grounded in the published question, rubric, accepted answers
 * and source excerpt. The model returns a verdict only; points come from the configured snapshot. Failures,
 * budget exhaustion and refusals become needs_review (admin) - never "incorrect" by default.
 */
export async function handleGrade(ctx: AppContext, data: { submissionId: number }): Promise<void> {
  const row = await ctx.db
    .selectFrom("submissions as s")
    .innerJoin("question_instances as qi", "qi.id", "s.instance_id")
    .innerJoin("question_versions as v", "v.id", "qi.question_version_id")
    .select(["s.id", "s.verdict", "s.answer_text", "s.group_id", "qi.game_type", "v.id as version_id", "v.content", "v.content_hash", "v.source_excerpt", "v.language"])
    .where("s.id", "=", data.submissionId)
    .executeTakeFirst();
  if (!row || row.verdict !== "pending") return; // idempotent: already graded
  const s = await getSettings(ctx, ctx.db, row.group_id);
  const gameType = row.game_type as GameType;
  const content = parseContent(gameType, row.content);
  const answer = row.answer_text ?? "";
  let question = "";
  let rubric = "";
  let accepted: string[] = [];
  let normalized = "";
  if (gameType === "find_mistake") {
    const c = content as ContentOf<"find_mistake">;
    question = `${c.prompt}\n${c.code}`;
    rubric = c.rubric;
    accepted = [c.fixedCode, ...c.acceptedFixes];
    normalized = codeKey(answer, c.codeLanguage);
  } else if (gameType === "guess_word") {
    const c = content as ContentOf<"guess_word">;
    question = c.clues.join("\n");
    rubric = "The guess must name the same word/term as the answer.";
    accepted = [c.answer, ...c.acceptedVariants];
    normalized = normalizeWord(answer);
  } else {
    await applyVerdict(ctx, ctx.db, { submissionId: row.id, verdict: "needs_review", method: "system", reason: "unexpected game type for AI grading" });
    return;
  }
  // A cached grade is reused only for the exact same question version, rubric, source, model and answer.
  const cacheKey = sha256(
    [PROMPT_VERSION, row.version_id, row.content_hash, hashContent(rubric), sha256(row.source_excerpt), ctx.cfg.AI_GRADING_MODEL, s.allowMultilingualVariants, normalized].join("|"),
  );
  const cached = await ctx.db.selectFrom("ai_grade_cache").selectAll().where("cache_key", "=", cacheKey).executeTakeFirst();
  if (cached) {
    await ctx.db.transaction().execute((tx) =>
      applyVerdict(ctx, tx, { submissionId: row.id, verdict: cached.verdict, method: "ai", reason: `${cached.reason} (cached)`, model: cached.model, cacheKey }),
    );
    return;
  }
  // Anonymous request key: no student name or Telegram id is sent to the AI provider.
  const requestKey = createHmac("sha256", ctx.cfg.CALLBACK_SECRET).update(`grade:${row.id}`).digest("hex").slice(0, 16);
  const input = {
    requestKey,
    gameType,
    question,
    rubric,
    acceptedAnswers: accepted,
    sourceExcerpt: row.source_excerpt.slice(0, 1200),
    studentAnswer: answer,
    language: row.language,
    allowTranslations: s.allowMultilingualVariants,
  };
  let out: GradeOutput;
  let model = ctx.cfg.AI_GRADING_MODEL;
  try {
    const res = await runAi(ctx, row.group_id, "grade", buildGradeRequest(ctx.cfg, input));
    out = res.data;
    model = res.model;
  } catch (err) {
    const reason =
      err instanceof AiBudgetExceeded ? "AI budget reached: admin review needed" : err instanceof AiPermanentError ? `AI could not grade (${err.code})` : `AI grading failed: ${(err as Error).message}`;
    ctx.log.warn({ submissionId: row.id, reason }, "AI grading unavailable - pending admin review");
    await ctx.db.transaction().execute((tx) => applyVerdict(ctx, tx, { submissionId: row.id, verdict: "needs_review", method: "system", reason }));
    return;
  }
  await ctx.db.transaction().execute(async (tx) => {
    if (out.verdict !== "needs_review") {
      await tx
        .insertInto("ai_grade_cache")
        .values({ cache_key: cacheKey, verdict: out.verdict, reason: out.reason.slice(0, 300), model })
        .onConflict((oc) => oc.column("cache_key").doNothing())
        .execute();
    }
    await applyVerdict(ctx, tx, { submissionId: row.id, verdict: out.verdict, method: "ai", reason: out.reason, model, cacheKey });
  });
}

/** Admin verdict correction (a reason is required). Past days are recalculated through audited entries. */
export async function adminCorrectVerdict(ctx: AppContext, submissionId: number, verdict: "correct" | "incorrect", reason: string, actorId: number): Promise<{ ok: boolean; error?: string }> {
  if (reason.trim().length < 3) return { ok: false, error: "Sabab yozilishi shart." };
  return ctx.db.transaction().execute(async (tx) => {
    const sub = await tx.selectFrom("submissions").select(["id", "group_id", "instance_id", "verdict"]).where("id", "=", submissionId).executeTakeFirst();
    if (!sub) return { ok: false, error: "Javob topilmadi." };
    await applyVerdict(ctx, tx, { submissionId, verdict, method: "admin", reason: reason.trim(), actorId });
    const plan = await tx
      .selectFrom("question_instances as qi")
      .innerJoin("day_plans as dp", "dp.id", "qi.day_plan_id")
      .select(["dp.local_date", "dp.status"])
      .where("qi.id", "=", sub.instance_id)
      .executeTakeFirstOrThrow();
    if (plan.status === "finished") await recalcFromDate(ctx, tx, sub.group_id, plan.local_date);
    await audit(tx, sub.group_id, actorId, "answer.correct_verdict", { submissionId, from: sub.verdict, to: verdict, reason: reason.trim() });
    return { ok: true };
  });
}
