import type { AppContext } from "../app/context.js";
import type { Executor } from "../db/db.js";
import type { Row } from "../db/schema.js";
import type { GameType } from "../domain/gameTypes.js";
import { computeSlots, dayEnd } from "../domain/schedule.js";
import { gameForWeekday, type GroupSettings } from "../domain/settings.js";
import { addDays, localDateOf, weekdayOf } from "../domain/time.js";
import { audit } from "./audit.js";
import { getSettings, listActiveGroups } from "./groups.js";
import { assignPlan } from "./questionBank.js";
import { enqueue } from "./outbox.js";
import { invalidateInstance } from "./scoring.js";

/**
 * Day plans. Exactly one game type per group per local calendar day. The type is frozen when the first
 * question of the day is published; later changes only affect future days. Unpublished slots keep their
 * identity (id/slot) when settings change; only their times are recalculated.
 */

async function createSlots(ex: Executor, plan: Row<"day_plans">, s: GroupSettings, gameType: GameType, fromSlot: number, now: Date) {
  const slots = computeSlots(s, plan.local_date);
  for (const slot of slots.filter((x) => x.slot >= fromSlot)) {
    const inst = await ex
      .insertInto("question_instances")
      .values({
        group_id: plan.group_id,
        day_plan_id: plan.id,
        slot: slot.slot,
        game_type: gameType,
        publish_at: slot.publishAt,
        close_at: slot.closeAt,
        ...(slot.publishAt < now ? { state: "skipped" as const, state_reason: "planned after its start time" } : {}),
      })
      .onConflict((oc) => oc.columns(["day_plan_id", "slot"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inst && gameType === "guess_word") {
      await ex
        .insertInto("clue_stages")
        .values(slot.clueAt.map((at, i) => ({ instance_id: inst.id, stage: i + 2, scheduled_at: at })))
        .onConflict((oc) => oc.columns(["instance_id", "stage"]).doNothing())
        .execute();
    }
  }
}

export async function ensureDayPlan(ctx: AppContext, ex: Executor, groupId: number, localDate: string, s: GroupSettings): Promise<Row<"day_plans">> {
  const existing = await ex.selectFrom("day_plans").selectAll().where("group_id", "=", groupId).where("local_date", "=", localDate).executeTakeFirst();
  if (existing) return existing;
  const now = ctx.clock.now();
  const gameType = gameForWeekday(s, weekdayOf(localDate));
  const plan = await ex
    .insertInto("day_plans")
    .values({
      group_id: groupId,
      local_date: localDate,
      game_type: gameType,
      status: gameType ? "planned" : "off",
      report_due_at: gameType ? dayEnd(s, localDate) : null,
    })
    .onConflict((oc) => oc.columns(["group_id", "local_date"]).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (!plan) return ex.selectFrom("day_plans").selectAll().where("group_id", "=", groupId).where("local_date", "=", localDate).executeTakeFirstOrThrow();
  if (gameType) {
    // A plan created after the day's end (e.g. bot added late) has nothing left to run.
    if (dayEnd(s, localDate) <= now) {
      await ex.updateTable("day_plans").set({ status: "off" }).where("id", "=", plan.id).execute();
      return { ...plan, status: "off" };
    }
    await createSlots(ex, plan, s, gameType, 0, now);
    await assignPlan(ctx, ex, plan.id);
  }
  return plan;
}

/** Ensure plans for today .. today + bufferDays for every active group, and keep assignments filled. */
export async function ensurePlans(ctx: AppContext): Promise<void> {
  const groups = await listActiveGroups(ctx.db);
  for (const g of groups) {
    await ctx.db.transaction().execute(async (tx) => {
      const s = await getSettings(ctx, tx, g.id);
      const today = localDateOf(ctx.clock.now(), s.timezone);
      for (let i = 0; i <= s.bankBufferDays; i++) {
        const plan = await ensureDayPlan(ctx, tx, g.id, addDays(today, i), s);
        if (plan.status === "planned" || plan.status === "active") await assignPlan(ctx, tx, plan.id);
      }
    });
  }
}

/**
 * Re-apply settings to unpublished slots of today and future days (call inside the settings transaction).
 * Published questions keep their deadlines; frozen days keep their game type.
 */
export async function reconcileGroup(ctx: AppContext, ex: Executor, groupId: number): Promise<void> {
  const s = await getSettings(ctx, ex, groupId);
  const now = ctx.clock.now();
  const today = localDateOf(now, s.timezone);
  const plans = await ex
    .selectFrom("day_plans")
    .selectAll()
    .where("group_id", "=", groupId)
    .where("local_date", ">=", today)
    .where("status", "in", ["planned", "active", "off"])
    .forUpdate()
    .execute();
  for (const plan of plans) {
    let gameType = plan.game_type as GameType | null;
    if (!plan.frozen_at) {
      const desired = plan.type_source === "override" ? gameType : gameForWeekday(s, weekdayOf(plan.local_date));
      if (desired !== gameType) {
        await ex.updateTable("question_instances").set({ state: "canceled", state_reason: "game type changed before the day started" }).where("day_plan_id", "=", plan.id).where("state", "=", "scheduled").execute();
        gameType = desired;
        await ex.updateTable("day_plans").set({ game_type: gameType, status: gameType ? "planned" : "off", updated_at: now }).where("id", "=", plan.id).execute();
        if (!gameType) continue;
        // Recreate slots for the new type: old canceled slots keep their rows, new ones get new slot numbers.
        const maxSlot = await ex.selectFrom("question_instances").select((eb) => eb.fn.max("slot").as("m")).where("day_plan_id", "=", plan.id).executeTakeFirst();
        await recreateWithOffset(ctx, ex, { ...plan, game_type: gameType }, s, gameType, (maxSlot?.m ?? -1) + 1, now);
        await ex.updateTable("day_plans").set({ report_due_at: dayEnd(s, plan.local_date) }).where("id", "=", plan.id).execute();
        await assignPlan(ctx, ex, plan.id);
        continue;
      }
    }
    if (!gameType || plan.status === "off") continue;
    await retime(ctx, ex, plan, s, gameType, now);
    await assignPlan(ctx, ex, plan.id);
  }
}

/** Slots are identified by (plan, slot). When a type change cancels old slots, new slots continue numbering. */
async function recreateWithOffset(ctx: AppContext, ex: Executor, plan: Row<"day_plans">, s: GroupSettings, gameType: GameType, offset: number, now: Date) {
  const slots = computeSlots(s, plan.local_date);
  for (const slot of slots) {
    const inst = await ex
      .insertInto("question_instances")
      .values({
        group_id: plan.group_id,
        day_plan_id: plan.id,
        slot: offset + slot.slot,
        game_type: gameType,
        publish_at: slot.publishAt,
        close_at: slot.closeAt,
        ...(slot.publishAt < now ? { state: "skipped" as const, state_reason: "planned after its start time" } : {}),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (gameType === "guess_word") {
      await ex.insertInto("clue_stages").values(slot.clueAt.map((at, i) => ({ instance_id: inst.id, stage: i + 2, scheduled_at: at }))).execute();
    }
  }
  void ctx;
}

/** Recalculate times of unpublished slots by their position among the day's active slots. */
async function retime(ctx: AppContext, ex: Executor, plan: Row<"day_plans">, s: GroupSettings, gameType: GameType, now: Date) {
  const slots = computeSlots(s, plan.local_date);
  const active = await ex
    .selectFrom("question_instances")
    .selectAll()
    .where("day_plan_id", "=", plan.id)
    .where("state", "not in", ["canceled"])
    .orderBy("slot")
    .execute();
  const offset = active.length ? active[0]!.slot : 0;
  for (const inst of active) {
    const pos = inst.slot - offset;
    if (inst.state !== "scheduled") continue;
    const target = slots[pos];
    if (!target) {
      await ex.updateTable("question_instances").set({ state: "canceled", state_reason: "removed by a settings change", updated_at: now }).where("id", "=", inst.id).execute();
      continue;
    }
    const patch =
      target.publishAt < now
        ? { state: "skipped" as const, state_reason: "rescheduled into the past", publish_at: target.publishAt, close_at: target.closeAt }
        : { publish_at: target.publishAt, close_at: target.closeAt };
    await ex.updateTable("question_instances").set({ ...patch, updated_at: now }).where("id", "=", inst.id).execute();
    if (gameType === "guess_word") {
      for (const [i, at] of target.clueAt.entries()) {
        await ex.updateTable("clue_stages").set({ scheduled_at: at }).where("instance_id", "=", inst.id).where("stage", "=", i + 2).where("state", "=", "scheduled").execute();
      }
    }
  }
  const lastPos = active.length ? active[active.length - 1]!.slot - offset : -1;
  for (const slot of slots.filter((x) => x.slot > lastPos)) {
    const inst = await ex
      .insertInto("question_instances")
      .values({ group_id: plan.group_id, day_plan_id: plan.id, slot: offset + slot.slot, game_type: gameType, publish_at: slot.publishAt, close_at: slot.closeAt, ...(slot.publishAt < now ? { state: "skipped" as const, state_reason: "planned after its start time" } : {}) })
      .onConflict((oc) => oc.columns(["day_plan_id", "slot"]).doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inst && gameType === "guess_word") {
      await ex.insertInto("clue_stages").values(slot.clueAt.map((at, i) => ({ instance_id: inst.id, stage: i + 2, scheduled_at: at }))).execute();
    }
  }
  // The report waits for the later of the new end time and any already-published question's deadline.
  const latestClose = await ex
    .selectFrom("question_instances")
    .select((eb) => eb.fn.max("close_at").as("m"))
    .where("day_plan_id", "=", plan.id)
    .where("state", "in", ["publishing", "open", "closing", "uncertain"])
    .executeTakeFirst();
  const end = dayEnd(s, plan.local_date);
  const due = latestClose?.m && new Date(latestClose.m as unknown as string) > end ? new Date(latestClose.m as unknown as string) : end;
  await ex.updateTable("day_plans").set({ report_due_at: due, updated_at: now }).where("id", "=", plan.id).execute();
  void ctx;
}

/** Choose another game type for a day that has not started (e.g. when picture content is unavailable). */
export async function overrideDayType(ctx: AppContext, ex: Executor, groupId: number, localDate: string, gameType: GameType | null, actorId: number): Promise<{ ok: boolean; reason?: string }> {
  const s = await getSettings(ctx, ex, groupId);
  const plan = await ensureDayPlan(ctx, ex, groupId, localDate, s);
  const locked = await ex.selectFrom("day_plans").selectAll().where("id", "=", plan.id).forUpdate().executeTakeFirstOrThrow();
  if (locked.frozen_at) return { ok: false, reason: "Bu kunning birinchi savoli yuborilgan — o'yin turi muzlatilgan. O'zgarish keyingi kunlarga tegishli." };
  if (["finished", "canceled"].includes(locked.status)) return { ok: false, reason: "Bu kun yakunlangan." };
  await ex.updateTable("day_plans").set({ type_source: "override", game_type: gameType, updated_at: ctx.clock.now() }).where("id", "=", plan.id).execute();
  if (gameType !== locked.game_type) {
    await ex.updateTable("question_instances").set({ state: "canceled", state_reason: "game type changed before the day started" }).where("day_plan_id", "=", plan.id).where("state", "=", "scheduled").execute();
    if (gameType) {
      const maxSlot = await ex.selectFrom("question_instances").select((eb) => eb.fn.max("slot").as("m")).where("day_plan_id", "=", plan.id).executeTakeFirst();
      await recreateWithOffset(ctx, ex, { ...locked, game_type: gameType }, s, gameType, (maxSlot?.m ?? -1) + 1, ctx.clock.now());
      await ex.updateTable("day_plans").set({ status: "planned", report_due_at: dayEnd(s, localDate) }).where("id", "=", plan.id).execute();
      await assignPlan(ctx, ex, plan.id);
    } else {
      await ex.updateTable("day_plans").set({ status: "off" }).where("id", "=", plan.id).execute();
    }
  }
  await audit(ex, groupId, actorId, "day.override_type", { localDate, gameType });
  return { ok: true };
}

/**
 * Stop Today: the active question is closed as canceled (no points, excluded from streak and accuracy),
 * unpublished questions are canceled, earlier valid results remain. The single daily report still goes
 * out at the configured end, or immediately when `finishNow` (Finish and Report) is chosen.
 */
export async function stopToday(ctx: AppContext, groupId: number, actorId: number, finishNow: boolean): Promise<{ ok: boolean; canceledActive: number; canceledScheduled: number }> {
  return ctx.db.transaction().execute(async (tx) => {
    const s = await getSettings(ctx, tx, groupId);
    const now = ctx.clock.now();
    const today = localDateOf(now, s.timezone);
    const plan = await tx.selectFrom("day_plans").selectAll().where("group_id", "=", groupId).where("local_date", "=", today).forUpdate().executeTakeFirst();
    if (!plan || ["finished", "off"].includes(plan.status)) return { ok: false, canceledActive: 0, canceledScheduled: 0 };
    const active = await tx.selectFrom("question_instances").selectAll().where("day_plan_id", "=", plan.id).where("state", "in", ["publishing", "open", "closing", "uncertain"]).execute();
    for (const inst of active) {
      await tx.updateTable("question_instances").set({ state: "canceled", closed_at: now, state_reason: "stopped by admin", updated_at: now }).where("id", "=", inst.id).execute();
      await tx.updateTable("clue_stages").set({ state: "canceled" }).where("instance_id", "=", inst.id).where("state", "=", "scheduled").execute();
      await invalidateInstance(ctx, tx, inst.id, actorId, "stopped by admin");
      await enqueueCancelActions(ctx, tx, inst);
    }
    const scheduled = await tx
      .updateTable("question_instances")
      .set({ state: "canceled", state_reason: "stopped by admin", updated_at: now })
      .where("day_plan_id", "=", plan.id)
      .where("state", "=", "scheduled")
      .returning("id")
      .execute();
    await tx
      .updateTable("day_plans")
      .set({ canceled_at: now, canceled_by: actorId, updated_at: now, ...(finishNow ? { finish_requested_at: now, finish_requested_by: actorId } : {}) })
      .where("id", "=", plan.id)
      .execute();
    await audit(tx, groupId, actorId, finishNow ? "day.stop_and_report" : "day.stop", { localDate: today, canceledActive: active.length, canceledScheduled: scheduled.length });
    return { ok: true, canceledActive: active.length, canceledScheduled: scheduled.length };
  });
}

/** Finish and Report: close the active question now (answers so far count), cancel the rest, report now. */
export async function finishAndReport(ctx: AppContext, groupId: number, actorId: number): Promise<boolean> {
  return ctx.db.transaction().execute(async (tx) => {
    const s = await getSettings(ctx, tx, groupId);
    const now = ctx.clock.now();
    const today = localDateOf(now, s.timezone);
    const plan = await tx.selectFrom("day_plans").selectAll().where("group_id", "=", groupId).where("local_date", "=", today).forUpdate().executeTakeFirst();
    if (!plan || !["planned", "active"].includes(plan.status)) return false;
    await tx.updateTable("day_plans").set({ finish_requested_at: now, finish_requested_by: actorId, updated_at: now }).where("id", "=", plan.id).execute();
    await audit(tx, groupId, actorId, "day.finish_and_report", { localDate: today });
    return true;
  });
}

async function enqueueCancelActions(ctx: AppContext, ex: Executor, inst: Row<"question_instances">) {
  if (!inst.chat_id || !inst.message_id) return;
  const isPoll = inst.game_type === "quiz_poll" || inst.game_type === "true_false";
  await enqueue(ex, {
    groupId: inst.group_id,
    chatId: inst.chat_id,
    method: isPoll ? "stopPoll" : "editMessageReplyMarkup",
    payload: isPoll ? { chat_id: inst.chat_id, message_id: inst.message_id } : { chat_id: inst.chat_id, message_id: inst.message_id, reply_markup: { inline_keyboard: [] } },
    dedupeKey: `cancel:${inst.id}`,
    purpose: "cancel",
    refId: inst.id,
  });
  void ctx;
}
