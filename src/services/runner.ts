import type { AppContext } from "../app/context.js";
import type { Executor, Tx } from "../db/db.js";
import type { Row } from "../db/schema.js";
import { parseContent, type ContentOf } from "../domain/content.js";
import { needsPrivateChat, type GameType } from "../domain/gameTypes.js";
import { pointsSnapshot } from "../domain/rules.js";
import { engineFor, renderClue } from "../games/engines.js";
import { t, type Lang } from "../i18n/index.js";
import { alertAdmins } from "./alerts.js";
import { getSettings } from "./groups.js";
import { enqueue, registerOutboxHandler } from "./outbox.js";
import { assignPlan } from "./questionBank.js";
import { markReportsStale } from "./reportsStale.js";
import { recomputeResult } from "./scoring.js";
import { pollAnswerForInstance } from "./submissions.js";

/**
 * Time-driven game flow. Each step claims rows with FOR UPDATE SKIP LOCKED plus a compare-and-set state
 * transition, so several workers can run without publishing the same item twice. Nothing depends on
 * in-memory timers: after a restart the next tick continues from the database state.
 */

const QUESTION_STATES_ACTIVE = ["publishing", "open", "closing", "uncertain"] as const;

export async function publishDue(ctx: AppContext, limit = 10): Promise<number> {
  let published = 0;
  for (let i = 0; i < limit; i++) {
    const did = await ctx.db.transaction().execute(async (tx) => {
      const now = ctx.clock.now();
      const inst = await tx
        .selectFrom("question_instances")
        .selectAll()
        .where("state", "=", "scheduled")
        .where("publish_at", "<=", now)
        .orderBy("publish_at")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!inst) return false;
      // Per group/day lock: serializes publication and freezing of the day's game type.
      const plan = await tx.selectFrom("day_plans").selectAll().where("id", "=", inst.day_plan_id).forUpdate().executeTakeFirstOrThrow();
      await publishOne(ctx, tx, inst, plan, now);
      return true;
    });
    if (!did) break;
    published++;
  }
  return published;
}

async function skip(ctx: AppContext, tx: Tx, inst: Row<"question_instances">, reason: string, alert: string | null) {
  await tx.updateTable("question_instances").set({ state: "skipped", state_reason: reason, updated_at: ctx.clock.now() }).where("id", "=", inst.id).execute();
  if (alert) await alertAdmins(ctx, tx, { key: `skip:${inst.id}`, groupId: inst.group_id, text: alert });
}

async function publishOne(ctx: AppContext, tx: Tx, inst: Row<"question_instances">, plan: Row<"day_plans">, now: Date) {
  if (!["planned", "active"].includes(plan.status) || plan.finish_requested_at || plan.canceled_at) {
    await tx.updateTable("question_instances").set({ state: "canceled", state_reason: `day ${plan.status}` }).where("id", "=", inst.id).execute();
    return;
  }
  const s = await getSettings(ctx, tx, inst.group_id);
  const slotNo = inst.slot + 1;
  // Never flood the group with old questions after downtime: stale slots are skipped and reported.
  const minWindowMs = Math.min(60_000, (inst.close_at.getTime() - inst.publish_at.getTime()) / 3);
  if (now.getTime() > inst.publish_at.getTime() + ctx.cfg.PUBLISH_GRACE_SECONDS * 1000 || inst.close_at.getTime() - now.getTime() < minWindowMs) {
    await skip(ctx, tx, inst, "missed publish time", `${slotNo}-savol vaqtida yuborilmadi (bot ishlamagan bo'lishi mumkin) va o'tkazib yuborildi.`);
    return;
  }
  // The day's type is frozen at the first publication; a slot of another type can never go out.
  if (plan.frozen_at && plan.game_type !== inst.game_type) {
    await skip(ctx, tx, inst, "game type mismatch", null);
    return;
  }
  if (!inst.question_version_id) await assignPlan(ctx, tx, plan.id);
  const fresh = await tx.selectFrom("question_instances").selectAll().where("id", "=", inst.id).executeTakeFirstOrThrow();
  const version = fresh.question_version_id
    ? await tx.selectFrom("question_versions").selectAll().where("id", "=", fresh.question_version_id).executeTakeFirst()
    : undefined;
  if (!version || version.review_status !== "approved" || version.game_type !== inst.game_type) {
    await skip(ctx, tx, inst, "no approved question", `${slotNo}-savol uchun tasdiqlangan savol topilmadi — o'tkazib yuborildi. Tekshirilmagan savol yuborilmaydi. "Savollar" bo'limida savollarni tasdiqlang.`);
    return;
  }
  const gameType = inst.game_type as GameType;
  const content = parseContent(gameType, version.content);
  let photoFileId: string | undefined;
  if (gameType === "picture_quiz") {
    const asset = await tx
      .selectFrom("picture_assets")
      .select(["telegram_file_id", "status"])
      .where("id", "=", (content as ContentOf<"picture_quiz">).assetId)
      .where("group_id", "=", inst.group_id)
      .executeTakeFirst();
    if (!asset || asset.status !== "approved") {
      await skip(ctx, tx, inst, "picture asset unavailable", `${slotNo}-savol rasmi mavjud emas yoki tasdiqlanmagan — savol o'tkazib yuborildi (kun turi o'zgartirilmadi).`);
      return;
    }
    photoFileId = asset.telegram_file_id;
  }

  const group = await tx.selectFrom("groups").select(["chat_id"]).where("id", "=", inst.group_id).executeTakeFirstOrThrow();
  const lang = s.language as Lang;
  if (!plan.frozen_at) {
    await tx.updateTable("day_plans").set({ frozen_at: now, status: "active", updated_at: now }).where("id", "=", plan.id).execute();
  }
  if (needsPrivateChat(gameType) && !plan.setup_prompt_sent) {
    await enqueue(tx, {
      groupId: inst.group_id,
      chatId: group.chat_id,
      method: "sendMessage",
      payload: {
        chat_id: group.chat_id,
        text: t(lang, "setupPrompt"),
        reply_markup: { inline_keyboard: [[{ text: t(lang, "setupButton"), url: `https://t.me/${ctx.bot.username}?start=s_${inst.group_id}` }]] },
      },
      dedupeKey: `setup:${plan.id}`,
      purpose: "setup_prompt",
    });
    await tx.updateTable("day_plans").set({ setup_prompt_sent: true }).where("id", "=", plan.id).execute();
  }
  const total = await tx
    .selectFrom("question_instances")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("day_plan_id", "=", plan.id)
    .where("state", "not in", ["canceled"])
    .executeTakeFirstOrThrow();
  const out = engineFor(gameType).render({
    instanceId: inst.id,
    chatId: group.chat_id,
    lang,
    content,
    slotNumber: slotNo,
    totalSlots: Number(total.n),
    secondsLeft: Math.floor((inst.close_at.getTime() - now.getTime()) / 1000),
    answerMinutes: Math.round((inst.close_at.getTime() - inst.publish_at.getTime()) / 60_000),
    hideResults: s.pollHideResultsUntilClose,
    codec: ctx.callbacks,
    botUsername: ctx.bot.username,
    ...(photoFileId ? { photoFileId } : {}),
  });
  await enqueue(tx, { groupId: inst.group_id, chatId: group.chat_id, method: out.method, payload: out.payload, dedupeKey: `q:${inst.id}`, purpose: "question", refId: inst.id });
  await tx
    .updateTable("question_instances")
    .set({ state: "publishing", chat_id: group.chat_id, points: JSON.stringify(pointsSnapshot(gameType, version.difficulty, s.points)), updated_at: now })
    .where("id", "=", inst.id)
    .where("state", "=", "scheduled")
    .execute();
  // From now on the content of this version can never change (DB trigger enforces it).
  if (!version.published_at) await tx.updateTable("question_versions").set({ published_at: now }).where("id", "=", version.id).execute();
  ctx.metrics.inc("questions_published_total");
}

export async function sendDueClues(ctx: AppContext): Promise<number> {
  const now = ctx.clock.now();
  return ctx.db.transaction().execute(async (tx) => {
    const due = await tx
      .selectFrom("clue_stages as cs")
      .innerJoin("question_instances as qi", "qi.id", "cs.instance_id")
      .select(["cs.instance_id", "cs.stage", "qi.state", "qi.close_at"])
      .where("cs.state", "=", "scheduled")
      .where("cs.scheduled_at", "<=", now)
      .forUpdate("cs")
      .skipLocked()
      .limit(20)
      .execute();
    for (const c of due) {
      if (!["open", "uncertain"].includes(c.state) || c.close_at <= now) {
        if (!["publishing", "scheduled"].includes(c.state)) {
          await tx.updateTable("clue_stages").set({ state: "canceled" }).where("instance_id", "=", c.instance_id).where("stage", "=", c.stage).execute();
        }
        continue;
      }
      const li = await tx.selectFrom("question_instances").selectAll().where("id", "=", c.instance_id).executeTakeFirstOrThrow();
      const v = await tx.selectFrom("question_versions").select(["content", "language"]).where("id", "=", li.question_version_id!).executeTakeFirstOrThrow();
      const content = parseContent("guess_word", v.content);
      const out = renderClue(v.language as Lang, li.chat_id!, li.message_id, content, c.stage as 2 | 3);
      await enqueue(tx, { groupId: li.group_id, chatId: li.chat_id!, method: out.method, payload: out.payload, dedupeKey: `clue:${li.id}:${c.stage}`, purpose: "clue", refId: li.id, refPart: c.stage });
      await tx.updateTable("clue_stages").set({ state: "sending" }).where("instance_id", "=", c.instance_id).where("stage", "=", c.stage).execute();
    }
    return due.length;
  });
}

/** Close questions whose server-side deadline passed. Published deadlines are never moved by settings. */
export async function closeDue(ctx: AppContext): Promise<number> {
  let closed = 0;
  for (let i = 0; i < 20; i++) {
    const did = await ctx.db.transaction().execute(async (tx) => {
      const now = ctx.clock.now();
      const inst = await tx
        .selectFrom("question_instances")
        .selectAll()
        .where("state", "in", ["open", "uncertain", "publishing"])
        .where("close_at", "<=", now)
        .orderBy("close_at")
        .limit(1)
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!inst) return false;
      await closeOne(ctx, tx, inst, now);
      return true;
    });
    if (!did) break;
    closed++;
  }
  // Safety net: a stopPoll that never completes must not keep a question in 'closing' forever.
  const stuck = await ctx.db
    .selectFrom("question_instances")
    .select("id")
    .where("state", "=", "closing")
    .where("close_at", "<", new Date(ctx.clock.now().getTime() - 5 * 60_000))
    .execute();
  for (const s of stuck) await ctx.db.transaction().execute((tx) => markClosed(ctx, tx, s.id));
  return closed;
}

async function closeOne(ctx: AppContext, tx: Tx, inst: Row<"question_instances">, now: Date) {
  await tx.updateTable("clue_stages").set({ state: "canceled" }).where("instance_id", "=", inst.id).where("state", "=", "scheduled").execute();
  if (inst.state !== "open") {
    // Never confirmed as delivered: excluded from opportunities (not counted as unanswered).
    await tx
      .updateTable("question_instances")
      .set({ state: "closed", closed_at: now, delivery_confirmed: false, state_reason: inst.state === "publishing" ? "never delivered" : "delivery uncertain", updated_at: now })
      .where("id", "=", inst.id)
      .execute();
    await finalizeInstance(ctx, tx, inst.id);
    await alertAdmins(ctx, tx, {
      key: `undelivered:${inst.id}`,
      groupId: inst.group_id,
      text: `${inst.slot + 1}-savol guruhga yetib borgani tasdiqlanmadi. U javobsizlar hisobiga kiritilmaydi. Agar savol guruhda ko'ringan bo'lsa, "Hisobotlar → Noaniq yuborishlar" bo'limida belgilang.`,
    });
    return;
  }
  const v = await tx.selectFrom("question_versions").select(["content", "language"]).where("id", "=", inst.question_version_id!).executeTakeFirstOrThrow();
  const gameType = inst.game_type as GameType;
  const content = parseContent(gameType, v.content);
  const engine = engineFor(gameType);
  const args = { chatId: inst.chat_id!, messageId: inst.message_id, lang: v.language as Lang, content };
  const actions = engine.closeActions(args);
  let n = 0;
  for (const a of actions) {
    await enqueue(tx, { groupId: inst.group_id, chatId: inst.chat_id!, method: a.method, payload: a.payload, dedupeKey: `close:${inst.id}:${n++}`, purpose: "close", refId: inst.id });
  }
  const reveal = engine.reveal(args);
  await enqueue(tx, { groupId: inst.group_id, chatId: inst.chat_id!, method: reveal.method, payload: reveal.payload, dedupeKey: `reveal:${inst.id}`, purpose: "reveal", refId: inst.id });
  const isPoll = gameType === "quiz_poll" || gameType === "true_false";
  if (isPoll && actions.length) {
    // Poll answers keep arriving until Telegram confirms the poll is stopped; then the question is closed.
    await tx.updateTable("question_instances").set({ state: "closing", updated_at: now }).where("id", "=", inst.id).execute();
  } else {
    await markClosed(ctx, tx, inst.id);
  }
}

export async function markClosed(ctx: AppContext, tx: Tx, instanceId: number): Promise<void> {
  const now = ctx.clock.now();
  const res = await tx
    .updateTable("question_instances")
    .set({ state: "closed", closed_at: now, updated_at: now })
    .where("id", "=", instanceId)
    .where("state", "in", ["closing", "open"])
    .returning("id")
    .executeTakeFirst();
  if (res) await finalizeInstance(ctx, tx, instanceId);
}

async function finalizeInstance(ctx: AppContext, tx: Executor, instanceId: number): Promise<void> {
  await tx.updateTable("question_instances").set({ results_finalized_at: ctx.clock.now() }).where("id", "=", instanceId).execute();
  const students = await tx.selectFrom("submissions").select("student_id").distinct().where("instance_id", "=", instanceId).execute();
  for (const s of students) await recomputeResult(ctx, tx, instanceId, s.student_id);
  const info = await tx
    .selectFrom("question_instances as qi")
    .innerJoin("day_plans as dp", "dp.id", "qi.day_plan_id")
    .select(["qi.group_id", "dp.local_date"])
    .where("qi.id", "=", instanceId)
    .executeTakeFirstOrThrow();
  await markReportsStale(tx, info.group_id, info.local_date);
}

// ---------------------------------------------------------------- outbox handlers

export function registerRunnerHandlers(): void {
  registerOutboxHandler("question", {
    async onSent(ctx, tx, row, result) {
      const r = (result ?? {}) as { message_id?: number; poll?: { id?: string }; markedDelivered?: boolean };
      const now = ctx.clock.now();
      const inst = await tx.selectFrom("question_instances").selectAll().where("id", "=", row.ref_id!).forUpdate().executeTakeFirstOrThrow();
      if (inst.state === "closed" && !inst.delivery_confirmed) {
        // Admin confirmed delivery after the window: the question now counts as delivered.
        await tx.updateTable("question_instances").set({ delivery_confirmed: true, state_reason: "delivery confirmed by admin" }).where("id", "=", inst.id).execute();
        await finalizeInstance(ctx, tx, inst.id);
        return;
      }
      await tx
        .updateTable("question_instances")
        .set({
          state: "open",
          delivery_confirmed: true,
          opened_at: inst.opened_at ?? now,
          message_id: r.message_id ?? inst.message_id,
          poll_id: r.poll?.id ?? inst.poll_id,
          updated_at: now,
        })
        .where("id", "=", inst.id)
        .where("state", "in", ["publishing", "uncertain"])
        .execute();
      if (r.poll?.id) await replayOrphanAnswers(ctx, tx, inst.id, r.poll.id);
    },
    async onFailed(ctx, tx, row, failure) {
      const now = ctx.clock.now();
      const inst = await tx.selectFrom("question_instances").selectAll().where("id", "=", row.ref_id!).executeTakeFirstOrThrow();
      if (failure.kind === "uncertain") {
        await tx.updateTable("question_instances").set({ state: "uncertain", state_reason: failure.reason, updated_at: now }).where("id", "=", inst.id).where("state", "=", "publishing").execute();
        await alertAdmins(ctx, tx, {
          key: `uncertain:${row.id}`,
          groupId: inst.group_id,
          text: `${inst.slot + 1}-savolni yuborishda javob kelmadi (Telegram qabul qilgan bo'lishi mumkin). Takroran yuborilmadi. "Hisobotlar → Noaniq yuborishlar" bo'limida hal qiling.`,
        });
      } else {
        await tx.updateTable("question_instances").set({ state: "failed", state_reason: failure.reason, updated_at: now }).where("id", "=", inst.id).execute();
        await alertAdmins(ctx, tx, { key: `failed:${row.id}`, groupId: inst.group_id, text: `${inst.slot + 1}-savol yuborilmadi: ${failure.reason}` });
      }
    },
  });

  registerOutboxHandler("clue", {
    async onSent(ctx, tx, row, result) {
      const r = (result ?? {}) as { message_id?: number };
      await tx
        .updateTable("clue_stages")
        .set({ state: "sent", sent_at: ctx.clock.now(), message_id: r.message_id ?? null })
        .where("instance_id", "=", row.ref_id!)
        .where("stage", "=", row.ref_part!)
        .execute();
      // Guesses received from now on belong to this stage (reward decided by server receipt stage).
      await tx
        .updateTable("question_instances")
        .set((eb) => ({ current_stage: eb.fn("greatest", [eb.ref("current_stage"), eb.val(row.ref_part!)]) }))
        .where("id", "=", row.ref_id!)
        .execute();
    },
    async onFailed(ctx, tx, row, failure) {
      await tx.updateTable("clue_stages").set({ state: failure.kind === "uncertain" ? "uncertain" : "failed" }).where("instance_id", "=", row.ref_id!).where("stage", "=", row.ref_part!).execute();
      void ctx;
    },
  });

  const closeHandler = {
    async onSent(ctx: AppContext, tx: Tx, row: Row<"outbox">) {
      await markClosed(ctx, tx, row.ref_id!);
    },
    async onFailed(ctx: AppContext, tx: Tx, row: Row<"outbox">) {
      await markClosed(ctx, tx, row.ref_id!);
    },
  };
  registerOutboxHandler("close", closeHandler);
}

/** Poll answers that arrived for an unknown poll id (uncertain delivery) are applied once the id is known. */
async function replayOrphanAnswers(ctx: AppContext, tx: Tx, instanceId: number, pollId: string) {
  const orphans = await tx.selectFrom("orphan_poll_answers").selectAll().where("poll_id", "=", pollId).execute();
  for (const o of orphans) {
    const user = await tx.selectFrom("telegram_users").selectAll().where("id", "=", o.user_id).executeTakeFirst();
    if (!user) continue;
    await pollAnswerForInstance(ctx, tx, instanceId, { id: user.id, is_bot: user.is_bot, first_name: user.first_name }, o.option_ids, o.received_at);
  }
  await tx.deleteFrom("orphan_poll_answers").where("poll_id", "=", pollId).execute();
}

export async function activeInstanceCount(ex: Executor): Promise<number> {
  const r = await ex.selectFrom("question_instances").select((eb) => eb.fn.countAll<number>().as("n")).where("state", "in", [...QUESTION_STATES_ACTIVE]).executeTakeFirstOrThrow();
  return Number(r.n);
}
