import { sql } from "kysely";
import type { AppContext } from "../app/context.js";
import { generationPrompt, PROMPT_VERSION, reviewPrompt, type ReviewItemInput, type SectionInput } from "../ai/prompts.js";
import { AiPermanentError } from "../ai/provider.js";
import { AiBudgetExceeded, runAi } from "../ai/run.js";
import { generationSchema, ReviewSchema, type GenItem, type GenerationOutput, type ReviewOutput } from "../ai/schemas.js";
import type { Executor } from "../db/db.js";
import type { Row } from "../db/schema.js";
import type { ContentOf, QuestionDraft } from "../domain/content.js";
import type { Difficulty, GameType, Origin } from "../domain/gameTypes.js";
import { validateDraft } from "../domain/questionValidation.js";
import { allocateDifficulties, splitSourceExtra } from "../domain/rules.js";
import { hashContent } from "../domain/similarity.js";
import { addDays, localDateOf } from "../domain/time.js";
import { gameName } from "../i18n/index.js";
import { alertAdmins } from "./alerts.js";
import { audit } from "./audit.js";
import { getSettings, listActiveGroups } from "./groups.js";
import { assignPlan, duplicateCorpus, storeVersion } from "./questionBank.js";

/**
 * Question preparation pipeline (all in background jobs, never on the send path):
 *   materials -> structured draft generation -> deterministic validation -> separate AI review
 *   -> bounded regeneration of rejected items -> admin approval (or optional auto-publish) -> immutable versions.
 * A second AI pass helps but is not proof of correctness; manual approval is the default.
 */

const MAX_BATCH_ATTEMPTS = 3;
const MAX_MATERIAL_CHARS = 24_000;

export async function createBatch(
  ctx: AppContext,
  ex: Executor,
  a: { groupId: number; gameType: GameType; count: number; targetDate?: string | null; actorId: number | null },
): Promise<{ ok: true; batchId: number } | { ok: false; reason: string }> {
  const s = await getSettings(ctx, ex, a.groupId);
  const materials = await ex
    .selectFrom("materials")
    .select(["id", "content_hash"])
    .where("group_id", "=", a.groupId)
    .where("status", "=", "ready")
    .where("active", "=", true)
    .orderBy("id")
    .execute();
  if (!materials.length) return { ok: false, reason: "Faol (tayyor) material yo'q. Avval dars matni yoki hujjat yuklang." };
  const count = Math.max(1, Math.min(30, a.count));
  const split = splitSourceExtra(count, s.sourceRatio);
  const difficulties = allocateDifficulties(count, s.difficultyMix);
  const inputHash = hashContent({
    v: PROMPT_VERSION,
    materials: materials.map((m) => m.content_hash),
    gameType: a.gameType,
    count,
    split,
    difficulties,
    topic: s.topic,
    level: s.level,
    language: s.language,
    model: ctx.cfg.AI_GENERATION_MODEL,
  });
  // Identical request already running: reuse it instead of paying twice.
  const running = await ex
    .selectFrom("generation_batches")
    .select("id")
    .where("group_id", "=", a.groupId)
    .where("input_hash", "=", inputHash)
    .where("status", "in", ["queued", "generating", "reviewing"])
    .executeTakeFirst();
  if (running) return { ok: true, batchId: running.id };
  const batch = await ex
    .insertInto("generation_batches")
    .values({
      group_id: a.groupId,
      game_type: a.gameType,
      language: s.language,
      topic: s.topic,
      level: s.level,
      requested_count: count,
      source_count: split.source,
      extra_count: split.extra,
      difficulty_plan: JSON.stringify(difficulties),
      material_ids: materials.map((m) => m.id),
      input_hash: inputHash,
      target_date: a.targetDate ?? null,
      created_by: a.actorId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await ctx.jobs.send("questions.generate", { batchId: batch.id }, { singletonKey: `gen:${batch.id}` }, ex);
  await audit(ex, a.groupId, a.actorId, "questions.generate", { batchId: batch.id, gameType: a.gameType, count });
  return { ok: true, batchId: batch.id };
}

/** Pick the most relevant sections within a character budget (topic keyword overlap, then document order). */
export function selectSections(sections: SectionInput[], topic: string, budget = MAX_MATERIAL_CHARS): SectionInput[] {
  const words = topic
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3);
  const scored = sections.map((s, i) => {
    const lower = s.text.toLowerCase();
    return { s, i, score: words.reduce((acc, w) => acc + (lower.includes(w) ? 1 : 0), 0) };
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  const out: { s: SectionInput; i: number }[] = [];
  let used = 0;
  for (const x of scored) {
    if (used + x.s.text.length > budget) continue;
    out.push(x);
    used += x.s.text.length;
  }
  return out.sort((a, b) => a.i - b.i).map((x) => x.s);
}

function toDraft(item: GenItem, gameType: GameType, language: "uz" | "ru" | "en", sectionRefs: Map<number, string>): QuestionDraft {
  const { origin, difficulty, sourceSectionIds, supportingExcerpt, ...rest } = item as GenItem & Record<string, unknown>;
  const content: Record<string, unknown> = { ...rest };
  if (gameType === "guess_word") content.clues = (content.clues as string[]).slice(0, 3);
  return {
    gameType,
    language,
    difficulty,
    origin,
    content,
    sourceRefs: origin === "source" ? sourceSectionIds.map((id) => ({ sectionId: id, ref: sectionRefs.get(id) ?? "?" })) : [],
    sourceExcerpt: origin === "source" ? supportingExcerpt.slice(0, 600) : "",
  };
}

interface SlotSpec {
  origin: Origin;
  difficulty: Difficulty;
  questionId?: number;
  feedback?: string[];
}

export async function handleGenerate(ctx: AppContext, data: { batchId: number; retryVersionIds?: number[] }): Promise<void> {
  const batch = await ctx.db.selectFrom("generation_batches").selectAll().where("id", "=", data.batchId).executeTakeFirst();
  if (!batch || ["done", "failed"].includes(batch.status)) return;
  if (batch.attempts >= MAX_BATCH_ATTEMPTS) {
    await finishBatch(ctx, batch, "partial", "regeneration limit reached");
    return;
  }
  await ctx.db.updateTable("generation_batches").set((eb) => ({ status: "generating", attempts: eb("attempts", "+", 1) })).where("id", "=", batch.id).execute();
  const s = await getSettings(ctx, ctx.db, batch.group_id);
  const gameType = batch.game_type as GameType;

  // Which items to produce: the full plan, or replacements for rejected items (same origin/difficulty).
  let slots: SlotSpec[];
  if (data.retryVersionIds?.length) {
    const rejected = await ctx.db.selectFrom("question_versions").select(["question_id", "origin", "difficulty", "ai_review", "validation_errors"]).where("id", "in", data.retryVersionIds).execute();
    slots = rejected.map((r) => ({
      origin: r.origin,
      difficulty: r.difficulty,
      questionId: r.question_id,
      feedback: [...((r.ai_review as { problems?: string[] } | null)?.problems ?? []), ...((r.validation_errors as string[]) ?? [])],
    }));
  } else {
    const diffs = batch.difficulty_plan as Difficulty[];
    slots = diffs.map((difficulty, i) => ({ origin: i < batch.source_count ? "source" : "extra", difficulty }));
  }

  const sectionRows = await ctx.db
    .selectFrom("material_sections as ms")
    .innerJoin("materials as m", "m.id", "ms.material_id")
    .select(["ms.id", "ms.ref", "ms.text", "m.title"])
    .where("ms.material_id", "in", batch.material_ids.length ? batch.material_ids : [0])
    .where("m.status", "=", "ready")
    .where("m.group_id", "=", batch.group_id)
    .orderBy("ms.material_id")
    .orderBy("ms.idx")
    .execute();
  const sections = selectSections(sectionRows.map((r) => ({ id: r.id, ref: `${r.title} · ${r.ref}`, text: r.text })), batch.topic);
  const sectionText = new Map(sectionRows.map((r) => [r.id, r.text]));
  const sectionRefs = new Map(sections.map((r) => [r.id, r.ref]));
  const corpus = await duplicateCorpus(ctx.db, batch.group_id, s.recentRepeatDays, ctx.clock.now());
  const assets =
    gameType === "picture_quiz"
      ? (await ctx.db.selectFrom("picture_assets").select(["id", "description", "review"]).where("group_id", "=", batch.group_id).where("status", "=", "approved").execute()).map((a) => ({
          id: a.id,
          description: a.description,
          visibleText: String((a.review as { visibleText?: string } | null)?.visibleText ?? ""),
        }))
      : [];
  if (gameType === "picture_quiz" && assets.length === 0) {
    await finishBatch(ctx, batch, "failed", "no approved picture assets");
    await alertAdmins(ctx, ctx.db, {
      key: `noassets:${batch.group_id}:${batch.target_date ?? batch.id}`,
      groupId: batch.group_id,
      text: "Rasmli savollar uchun tasdiqlangan rasm yo'q. \"Savollar → Rasmlar\" bo'limida rasm yuklang yoki o'sha kun uchun boshqa o'yin turini tanlang. Kun turi o'z-o'zidan o'zgartirilmaydi.",
    });
    return;
  }

  const input = {
    gameType,
    language: batch.language,
    topic: batch.topic,
    level: batch.level,
    slots: slots.map((x) => ({ origin: x.origin, difficulty: x.difficulty })),
    sections,
    avoid: corpus.slice(-40).map((c) => c.text.slice(0, 160)),
    assets,
    allowTranslations: s.allowMultilingualVariants,
    feedback: [...new Set(slots.flatMap((x) => x.feedback ?? []))].slice(0, 20),
  };
  const prompt = generationPrompt(input);
  let output: GenerationOutput;
  try {
    const res = await runAi(ctx, batch.group_id, "generate", {
      task: "generate_questions",
      model: ctx.cfg.AI_GENERATION_MODEL,
      effort: ctx.cfg.AI_GENERATION_EFFORT,
      system: prompt.system,
      content: [{ type: "text", text: prompt.text }],
      schema: generationSchema(gameType) as never,
      maxTokens: 16000,
      timeoutMs: ctx.cfg.AI_TIMEOUT_MS,
      input,
    });
    output = res.data as GenerationOutput;
  } catch (err) {
    if (err instanceof AiBudgetExceeded || err instanceof AiPermanentError) {
      await finishBatch(ctx, batch, "failed", (err as Error).message);
      await alertAdmins(ctx, ctx.db, { key: `genfail:${batch.id}`, groupId: batch.group_id, text: `Savol yaratish to'xtadi: ${(err as Error).message}` });
      return;
    }
    await ctx.db.updateTable("generation_batches").set({ status: "queued", error: (err as Error).message }).where("id", "=", batch.id).execute();
    throw err; // transient: pg-boss retries with backoff, then dead-letter -> admin alert
  }

  if (output.cannotGenerate && output.items.length === 0) {
    await finishBatch(ctx, batch, "failed", output.cannotGenerateReason);
    await alertAdmins(ctx, ctx.db, {
      key: `cannot:${batch.id}`,
      groupId: batch.group_id,
      text: `${gameName("uz", gameType)} savollarini bu mavzudan aniq tuzib bo'lmadi: ${output.cannotGenerateReason}\nBoshqa o'yin turini tanlang ("O'yin turlari"). Kun turi o'z-o'zidan o'zgartirilmaydi.`,
    });
    return;
  }

  const assetIds = new Set(assets.map((a) => a.id));
  const passed: number[] = [];
  const failedRetry: number[] = [];
  await ctx.db.transaction().execute(async (tx) => {
    for (const [i, item] of output.items.slice(0, slots.length).entries()) {
      const slot = slots[i]!;
      const draft = toDraft({ ...item, origin: slot.origin, difficulty: slot.difficulty } as GenItem, gameType, batch.language as "uz", sectionRefs);
      const v = validateDraft(draft, {
        sections: sectionText,
        assetIds,
        existing: corpus,
        expectedGameType: gameType,
        expectedLanguage: batch.language,
        readingLevel: /bola|kid|child|young|1-4|boshlang/i.test(batch.level) ? "young" : "standard",
      });
      const row = await storeVersion(tx, {
        groupId: batch.group_id,
        batchId: batch.id,
        draft,
        content: (v.content ?? draft.content) as Record<string, unknown>,
        contentHash: v.contentHash ?? hashContent(draft.content),
        searchText: v.text ?? JSON.stringify(draft.content).slice(0, 500),
        status: v.ok ? "draft" : "rejected",
        errors: v.errors,
        attempt: batch.attempts + 1,
        ...(slot.questionId ? { questionId: slot.questionId } : {}),
      });
      if (v.ok) {
        passed.push(row.id);
        corpus.push({ hash: v.contentHash!, text: v.text! });
      } else failedRetry.push(row.id);
    }
  });
  ctx.log.info({ batchId: batch.id, passed: passed.length, rejected: failedRetry.length }, "generation validated");
  if (passed.length) {
    await ctx.db.updateTable("generation_batches").set({ status: "reviewing" }).where("id", "=", batch.id).execute();
    await ctx.jobs.send("questions.review", { batchId: batch.id, versionIds: passed }, { singletonKey: `rev:${batch.id}:${batch.attempts}` });
  }
  const missing = slots.length - output.items.length;
  if (failedRetry.length || missing > 0) {
    if (batch.attempts + 1 < MAX_BATCH_ATTEMPTS && failedRetry.length) {
      await ctx.jobs.send("questions.generate", { batchId: batch.id, retryVersionIds: failedRetry }, { singletonKey: `gen:${batch.id}:${batch.attempts + 1}` });
    } else if (!passed.length) {
      await finishBatch(ctx, batch, "partial", "validation rejected all items");
    }
  }
}

export async function handleReview(ctx: AppContext, data: { batchId: number; versionIds: number[] }): Promise<void> {
  const batch = await ctx.db.selectFrom("generation_batches").selectAll().where("id", "=", data.batchId).executeTakeFirst();
  if (!batch) return;
  const versions = await ctx.db.selectFrom("question_versions").selectAll().where("id", "in", data.versionIds).where("review_status", "=", "draft").execute();
  if (!versions.length) return;
  const s = await getSettings(ctx, ctx.db, batch.group_id);
  const sectionIds = versions.flatMap((v) => (v.source_refs as { sectionId: number }[]).map((r) => r.sectionId));
  const sectionText = new Map(
    (sectionIds.length ? await ctx.db.selectFrom("material_sections").select(["id", "text"]).where("id", "in", sectionIds).execute() : []).map((r) => [r.id, r.text]),
  );
  const assetText = new Map<number, string>();
  if (batch.game_type === "picture_quiz") {
    for (const a of await ctx.db.selectFrom("picture_assets").select(["id", "review"]).where("group_id", "=", batch.group_id).execute()) {
      assetText.set(a.id, String((a.review as { visibleText?: string } | null)?.visibleText ?? ""));
    }
  }
  const items: ReviewItemInput[] = versions.map((v) => ({
    itemId: String(v.id),
    gameType: v.game_type as GameType,
    origin: v.origin,
    difficulty: v.difficulty,
    content: v.content,
    supportingExcerpt: v.source_excerpt,
    citedSections: (v.source_refs as { sectionId: number }[]).map((r) => (sectionText.get(r.sectionId) ?? "").slice(0, 3000)),
    ...(batch.game_type === "picture_quiz" ? { assetVisibleText: assetText.get(Number((v.content as ContentOf<"picture_quiz">).assetId)) ?? "" } : {}),
  }));
  const prompt = reviewPrompt(items, batch.language, batch.level);
  let review: ReviewOutput;
  try {
    const res = await runAi(ctx, batch.group_id, "review", {
      task: "review_questions",
      model: ctx.cfg.AI_REVIEW_MODEL,
      effort: ctx.cfg.AI_REVIEW_EFFORT,
      system: prompt.system,
      content: [{ type: "text", text: prompt.text }],
      schema: ReviewSchema,
      maxTokens: 8000,
      timeoutMs: ctx.cfg.AI_TIMEOUT_MS,
      input: { items },
    });
    review = res.data;
  } catch (err) {
    if (err instanceof AiBudgetExceeded || err instanceof AiPermanentError) {
      // Without a review nothing can be auto-approved; items stay as drafts for the admin to see.
      await finishBatch(ctx, batch, "partial", `review failed: ${(err as Error).message}`);
      await alertAdmins(ctx, ctx.db, { key: `revfail:${batch.id}`, groupId: batch.group_id, text: `Savollarni AI tekshiruvi bajarilmadi: ${(err as Error).message}` });
      return;
    }
    throw err;
  }

  const byId = new Map(review.reviews.map((r) => [r.itemId, r]));
  const rejected: number[] = [];
  let accepted = 0;
  const now = ctx.clock.now();
  await ctx.db.transaction().execute(async (tx) => {
    for (const v of versions) {
      const r = byId.get(String(v.id));
      // Application code decides: every relevant check must pass, and uncertain extra facts are rejected
      // (no retrieval source is configured to verify them).
      const checksOk =
        !!r &&
        r.verdict === "approve" &&
        r.singleCorrectAnswer &&
        r.clearWording &&
        r.noAnswerClue &&
        r.factuallyCorrect &&
        r.ageAppropriate &&
        r.safe &&
        r.readingLevelOk &&
        r.unambiguous &&
        (v.game_type === "true_false" || v.game_type === "find_mistake" || v.game_type === "guess_word" || r.distractorsPlausible) &&
        (v.origin === "extra" ? r.factualConfidence === "high" : r.supportedBySource);
      const reviewJson = JSON.stringify(r ?? { problems: ["missing review"] });
      if (checksOk) {
        const auto = s.approvalMode === "auto";
        await tx
          .updateTable("question_versions")
          .set({ review_status: auto ? "approved" : "validated", ai_review: reviewJson, ...(auto ? { approved_at: now } : {}) })
          .where("id", "=", v.id)
          .execute();
        accepted++;
      } else {
        const problems = r?.problems.length ? r.problems : ["reviewer did not approve"];
        if (v.origin === "extra" && r && r.factualConfidence !== "high") problems.push("uncertain extra fact (no retrieval configured)");
        await tx.updateTable("question_versions").set({ review_status: "ai_rejected", ai_review: JSON.stringify({ ...(r ?? {}), problems }) }).where("id", "=", v.id).execute();
        rejected.push(v.id);
      }
    }
  });
  if (rejected.length && batch.attempts < MAX_BATCH_ATTEMPTS) {
    await ctx.jobs.send("questions.generate", { batchId: batch.id, retryVersionIds: rejected }, { singletonKey: `gen:${batch.id}:r${batch.attempts}` });
  } else {
    await finishBatch(ctx, batch, rejected.length ? "partial" : "done", null);
  }
  if (accepted) {
    if (s.approvalMode === "auto") {
      // Fill unassigned upcoming slots with the newly approved questions.
      const plans = await ctx.db.selectFrom("day_plans").select("id").where("group_id", "=", batch.group_id).where("status", "in", ["planned", "active"]).execute();
      for (const p of plans) await ctx.db.transaction().execute((tx) => assignPlan(ctx, tx, p.id));
    } else {
      await alertAdmins(ctx, ctx.db, {
        key: `review:${batch.id}:${batch.attempts}`,
        groupId: batch.group_id,
        text: `${accepted} ta yangi savol (${gameName("uz", batch.game_type as GameType)}) tasdiqlashingizni kutmoqda: "Savollar → Tasdiqlash".`,
      });
    }
  }
}

async function finishBatch(ctx: AppContext, batch: Row<"generation_batches">, status: "done" | "failed" | "partial", error: string | null) {
  await ctx.db.updateTable("generation_batches").set({ status, error, finished_at: ctx.clock.now() }).where("id", "=", batch.id).execute();
}

/**
 * Bank preparation (periodic): make sure every upcoming game day within the buffer has approved questions of
 * that day's type. Generates more when needed (within budget), and alerts the admin about pending approvals,
 * missing materials or picture assets - before the day starts, never by switching the day's type.
 */
export async function handleBankPrepare(ctx: AppContext, data: { groupId?: number }): Promise<void> {
  const groups = data.groupId ? [{ id: data.groupId }] : await listActiveGroups(ctx.db);
  for (const g of groups) {
    const s = await getSettings(ctx, ctx.db, g.id);
    const today = localDateOf(ctx.clock.now(), s.timezone);
    const plans = await ctx.db
      .selectFrom("day_plans")
      .selectAll()
      .where("group_id", "=", g.id)
      .where("local_date", ">=", today)
      .where("local_date", "<=", addDays(today, s.bankBufferDays))
      .where("status", "in", ["planned", "active"])
      .orderBy("local_date")
      .execute();
    const shortfall = new Map<GameType, { missing: number; firstDate: string }>();
    for (const p of plans) {
      if (!p.game_type) continue;
      await ctx.db.transaction().execute((tx) => assignPlan(ctx, tx, p.id));
      const missing = await ctx.db
        .selectFrom("question_instances")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("day_plan_id", "=", p.id)
        .where("state", "=", "scheduled")
        .where("question_version_id", "is", null)
        .executeTakeFirstOrThrow();
      const n = Number(missing.n);
      if (!n) continue;
      const cur = shortfall.get(p.game_type as GameType);
      shortfall.set(p.game_type as GameType, { missing: (cur?.missing ?? 0) + n, firstDate: cur?.firstDate ?? p.local_date });
    }
    for (const [gameType, { missing, firstDate }] of shortfall) {
      const pendingReview = await ctx.db
        .selectFrom("question_versions as v")
        .innerJoin("questions as q", (j) => j.onRef("q.current_version_id", "=", "v.id"))
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("v.group_id", "=", g.id)
        .where("v.game_type", "=", gameType)
        .where("v.review_status", "=", "validated")
        .executeTakeFirstOrThrow();
      const inFlight = await ctx.db
        .selectFrom("generation_batches")
        .select("id")
        .where("group_id", "=", g.id)
        .where("game_type", "=", gameType)
        .where("status", "in", ["queued", "generating", "reviewing"])
        .executeTakeFirst();
      if (Number(pendingReview.n) >= missing) {
        await alertAdmins(ctx, ctx.db, {
          key: `approve:${g.id}:${gameType}:${firstDate}`,
          groupId: g.id,
          text: `${firstDate} uchun ${missing} ta ${gameName("uz", gameType)} savoli kerak. ${pendingReview.n} ta savol tasdiqlashni kutmoqda: "Savollar → Tasdiqlash".`,
        });
        continue;
      }
      if (inFlight) continue;
      // Cost guard: after a failed/partial batch wait an hour before trying the same type again.
      const recentFailure = await ctx.db
        .selectFrom("generation_batches")
        .select("id")
        .where("group_id", "=", g.id)
        .where("game_type", "=", gameType)
        .where("status", "in", ["failed", "partial"])
        .where("finished_at", ">", new Date(ctx.clock.now().getTime() - 3600_000))
        .executeTakeFirst();
      if (recentFailure) continue;
      const res = await ctx.db.transaction().execute((tx) =>
        createBatch(ctx, tx, { groupId: g.id, gameType, count: missing - Number(pendingReview.n) + 2, targetDate: firstDate, actorId: null }),
      );
      if (!res.ok) {
        await alertAdmins(ctx, ctx.db, { key: `nomaterial:${g.id}:${firstDate}`, groupId: g.id, text: `${firstDate} uchun savol tayyorlab bo'lmadi: ${res.reason}` });
      }
    }
  }
}

export async function pendingReviewCount(ex: Executor, groupId: number): Promise<number> {
  const r = await ex
    .selectFrom("question_versions as v")
    .innerJoin("questions as q", (j) => j.onRef("q.current_version_id", "=", "v.id"))
    .select(sql<number>`count(*)::int`.as("n"))
    .where("v.group_id", "=", groupId)
    .where("v.review_status", "=", "validated")
    .executeTakeFirstOrThrow();
  return r.n;
}
