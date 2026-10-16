import { afterAll, describe, expect, it } from "vitest";
import { addDays } from "../../src/domain/time.js";
import { overrideDayType } from "../../src/services/planner.js";
import { closeSharedDb, patchSettings, settle } from "../../src/sim/harness.js";
import { adminMessages, at, CHAT, openInstance, setupDay, todayPlanId } from "./setup.js";

afterAll(closeSharedDb);

describe("game days", () => {
  it("allows exactly one game type per local day and freezes it at the first publication", async () => {
    const d = await setupDay("quiz_poll");
    const { h, groupId } = d;
    await at(d, "18:00");
    const plan = await h.ctx.db.selectFrom("day_plans").selectAll().where("group_id", "=", groupId).where("local_date", "=", d.date).executeTakeFirstOrThrow();
    expect(plan.game_type).toBe("quiz_poll");
    expect(plan.frozen_at).not.toBeNull();
    expect(h.tg.messagesTo(CHAT).filter((m) => m.method === "sendPoll")).toHaveLength(1);

    // Changing Monday's mapping now only affects future Mondays; today's slots stay quiz polls.
    await patchSettings(h, groupId, { weekdayGame: { ...(await import("../../src/domain/settings.js")).defaultSettings().weekdayGame, "1": "emoji_puzzle" } });
    const types = await h.ctx.db.selectFrom("question_instances").select("game_type").distinct().where("day_plan_id", "=", plan.id).where("state", "!=", "canceled").execute();
    expect(types.map((t) => t.game_type)).toEqual(["quiz_poll"]);
    // A same-day override is refused after the freeze...
    const refused = await h.ctx.db.transaction().execute((tx) => overrideDayType(h.ctx, tx, groupId, d.date, "true_false", 1001));
    expect(refused.ok).toBe(false);
    // ...but tomorrow can still be changed.
    const ok = await h.ctx.db.transaction().execute((tx) => overrideDayType(h.ctx, tx, groupId, addDays(d.date, 1), "true_false", 1001));
    expect(ok.ok).toBe(true);
    const tomorrow = await h.ctx.db.selectFrom("day_plans").selectAll().where("group_id", "=", groupId).where("local_date", "=", addDays(d.date, 1)).executeTakeFirstOrThrow();
    expect(tomorrow.game_type).toBe("true_false");

    // Every question of the day uses the frozen type.
    for (const t of ["18:10", "18:30", "19:00", "19:30", "20:00", "20:30", "20:45"]) await at(d, t);
    const sentTypes = await h.ctx.db.selectFrom("question_instances").select("game_type").where("day_plan_id", "=", plan.id).where("opened_at", "is not", null).execute();
    expect(sentTypes.length).toBe(6);
    expect(new Set(sentTypes.map((x) => x.game_type))).toEqual(new Set(["quiz_poll"]));
  });

  it("lets different groups run different game types on the same day", async () => {
    const a = await setupDay("quiz_poll");
    const b = await setupDay("quiz_poll", { h: a.h, chatId: -1009, questions: 0, settings: { weekdayGame: { "1": "true_false", "2": "find_mistake", "3": "guess_word", "4": "true_false", "5": "picture_quiz", "6": "emoji_puzzle", "7": null } } });
    const plans = await a.h.ctx.db.selectFrom("day_plans").select(["group_id", "game_type"]).where("local_date", "=", a.date).orderBy("group_id").execute();
    expect(plans.map((p) => p.game_type)).toEqual(["quiz_poll", "true_false"]);
    void b;
  });

  it("recalculates only unpublished slots when times change mid-game, keeping published deadlines and slot identities", async () => {
    const d = await setupDay("quiz_poll");
    await at(d, "18:00");
    const today = await todayPlanId(d);
    const before = await d.h.ctx.db.selectFrom("question_instances").selectAll().where("day_plan_id", "=", today).orderBy("slot").execute();
    await patchSettings(d.h, d.groupId, { startTime: "18:05", endTime: "21:30" });
    const after = await d.h.ctx.db.selectFrom("question_instances").selectAll().where("day_plan_id", "=", today).orderBy("slot").execute();
    const first = after.find((x) => x.id === before[0]!.id)!;
    expect(first.close_at.toISOString()).toBe(before[0]!.close_at.toISOString()); // published deadline unchanged
    const second = after.find((x) => x.id === before[1]!.id)!;
    expect(second.publish_at.getTime() - before[1]!.publish_at.getTime()).toBe(5 * 60_000);
    expect(after.filter((x) => x.day_plan_id === before[0]!.day_plan_id).map((x) => x.id)).toEqual(before.map((x) => x.id));
  });

  it("never publishes unreviewed content: a slot without an approved question is skipped and the admin alerted", async () => {
    const d = await setupDay("true_false", { questions: 0 });
    // Questions exist but are only AI-validated, not approved by the admin.
    const { createBatch } = await import("../../src/services/generation.js");
    await d.h.ctx.db.transaction().execute((tx) => createBatch(d.h.ctx, tx, { groupId: d.groupId, gameType: "true_false", count: 6, actorId: 1001 }));
    await d.h.jobs.drain();
    const validated = await d.h.ctx.db.selectFrom("question_versions").select("id").where("review_status", "=", "validated").execute();
    expect(validated.length).toBeGreaterThan(0);
    await at(d, "18:00");
    expect(d.h.tg.messagesTo(CHAT).filter((m) => m.method === "sendPoll")).toHaveLength(0);
    const first = await d.h.ctx.db.selectFrom("question_instances").selectAll().where("day_plan_id", "=", await todayPlanId(d)).orderBy("slot").executeTakeFirstOrThrow();
    expect(first.state).toBe("skipped");
    expect(adminMessages(d.h).some((t) => t.includes("tasdiqlangan savol topilmadi"))).toBe(true);
  });

  it("keeps the day's type when a picture asset becomes unavailable (slot skipped, admin told)", async () => {
    const d = await setupDay("picture_quiz");
    await d.h.ctx.db.updateTable("picture_assets").set({ status: "rejected" }).where("group_id", "=", d.groupId).execute();
    await at(d, "18:00");
    const plan = await d.h.ctx.db.selectFrom("day_plans").selectAll().where("group_id", "=", d.groupId).where("local_date", "=", d.date).executeTakeFirstOrThrow();
    expect(plan.game_type).toBe("picture_quiz");
    expect(await openInstance(d)).toBeUndefined();
    expect(d.h.tg.messagesTo(CHAT).some((m) => m.method === "sendPhoto")).toBe(false);
    expect(adminMessages(d.h).some((t) => t.includes("rasmi mavjud emas"))).toBe(true);
  });

  it("sends the private-setup button before the first text-answer question", async () => {
    const d = await setupDay("find_mistake");
    await at(d, "18:00");
    const msgs = d.h.tg.messagesTo(CHAT);
    expect(msgs[0]!.text).toContain("shaxsiy chatda");
    expect(JSON.stringify(msgs[0]!.payload.reply_markup)).toContain("start=s_");
    await settle(d.h);
    expect(d.h.tg.messagesTo(CHAT).filter((m) => (m.text ?? "").includes("shaxsiy chatda"))).toHaveLength(1);
  });
});
