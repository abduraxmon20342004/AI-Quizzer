import type { Update } from "node-telegram-bot-api";
import { afterAll, describe, expect, it } from "vitest";
import { recoverStaleSending, resolveUncertain } from "../../src/services/outbox.js";
import { closeSharedDb, pollAnswerUpdate, student } from "../../src/sim/harness.js";
import { adminMessages, at, CHAT, contentOf, playDay, setupDay, todayPlanId } from "./setup.js";

afterAll(closeSharedDb);

const polls = (d: { h: { tg: { messagesTo(c: number): { method: string }[] } } }) => d.h.tg.messagesTo(CHAT).filter((m) => m.method === "sendPoll");

async function firstInstance(d: Awaited<ReturnType<typeof setupDay>>) {
  return d.h.ctx.db.selectFrom("question_instances").selectAll().where("day_plan_id", "=", await todayPlanId(d)).orderBy("slot").executeTakeFirstOrThrow();
}

describe("uncertain Telegram delivery", () => {
  it("never blindly resends after a timeout that Telegram may have accepted; the admin is alerted", async () => {
    const d = await setupDay("quiz_poll");
    d.h.tg.failNext("sendPoll", "timeout_after_accept");
    await at(d, "18:00");
    await at(d, "18:01");
    await at(d, "18:02");
    expect(polls(d)).toHaveLength(1); // Telegram received it once; we did not resend
    const inst = await firstInstance(d);
    expect(inst.state).toBe("uncertain");
    const ob = await d.h.ctx.db.selectFrom("outbox").selectAll().where("purpose", "=", "question").executeTakeFirstOrThrow();
    expect(ob.status).toBe("uncertain");
    expect(adminMessages(d.h).some((t) => t.includes("Takroran yuborilmadi"))).toBe(true);
  });

  it("recovers an uncertain poll from Telegram's poll update and applies answers that arrived meanwhile", async () => {
    const d = await setupDay("quiz_poll");
    d.h.tg.failNext("sendPoll", "timeout_after_accept");
    await at(d, "18:00");
    const sent = polls(d)[0] as unknown as { pollId: string; payload: { question: string } };
    const inst = await firstInstance(d);
    const correct = ((await contentOf(d, inst.id)).content as { correctIndex: number }).correctIndex;
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, student(0), sent.pollId, correct)); // unknown poll id -> parked
    expect(await d.h.ctx.db.selectFrom("orphan_poll_answers").selectAll().execute()).toHaveLength(1);
    await d.h.router.handleUpdate({ update_id: 99, poll: { id: sent.pollId, question: sent.payload.question, options: [], total_voter_count: 1, is_closed: false, is_anonymous: false, type: "quiz", allows_multiple_answers: false } } as unknown as Update);
    const after = await firstInstance(d);
    expect(after.state).toBe("open");
    expect(after.poll_id).toBe(sent.pollId);
    expect(await d.h.ctx.db.selectFrom("submissions").selectAll().execute()).toHaveLength(1);
    expect((await d.h.ctx.db.selectFrom("score_ledger").selectAll().execute()).length).toBe(1);
  });

  it("excludes a never-confirmed question from unanswered counts", async () => {
    const d = await setupDay("quiz_poll", { students: 2, settings: { questionsPerDay: 1, endTime: "18:30" } });
    d.h.tg.failNext("sendPoll", "timeout_after_accept");
    await playDay(d, {});
    const report = d.h.tg.messagesTo(CHAT).find((m) => (m.text ?? "").includes("Bugungi natijalar"))!;
    expect(report.text).toMatch(/Talaba0<\/b>: 0 ball$/m);
    expect(report.text).not.toMatch(/javobsiz/);
    const inst = await firstInstance(d);
    expect(inst.delivery_confirmed).toBe(false);
  });

  it("lets the admin explicitly resend an uncertain message (and records it)", async () => {
    const d = await setupDay("quiz_poll");
    d.h.tg.failNext("sendPoll", "timeout_after_accept");
    await at(d, "18:00");
    const ob = await d.h.ctx.db.selectFrom("outbox").selectAll().where("status", "=", "uncertain").executeTakeFirstOrThrow();
    expect(await resolveUncertain(d.h.ctx, ob.id, "resend", 1001)).toBe(true);
    await at(d, "18:01");
    expect(polls(d)).toHaveLength(2);
    expect((await firstInstance(d)).state).toBe("open");
    expect((await d.h.ctx.db.selectFrom("audit_events").select("action").where("action", "=", "outbox.resend").execute()).length).toBe(1);
  });

  it("retries sends that certainly did not reach Telegram (DNS failure, 429 retry_after)", async () => {
    const d = await setupDay("quiz_poll");
    d.h.tg.failNext("sendPoll", "network_before_send");
    await at(d, "18:00");
    expect((await firstInstance(d)).state).toBe("publishing");
    await at(d, "18:00", 3);
    expect((await firstInstance(d)).state).toBe("open");
    d.h.tg.failNext("sendMessage", "rate_limit"); // the reveal message at closing
    await at(d, "18:10", 1);
    const reveal = await d.h.ctx.db.selectFrom("outbox").selectAll().where("purpose", "=", "reveal").executeTakeFirstOrThrow();
    expect(reveal.status).toBe("pending");
    expect(reveal.last_error).toMatch(/retry_after/);
    await at(d, "18:10", 4);
    expect((await d.h.ctx.db.selectFrom("outbox").selectAll().where("purpose", "=", "reveal").executeTakeFirstOrThrow()).status).toBe("sent");
  });
});

describe("crash and restart recovery", () => {
  it("a send interrupted by a crash becomes uncertain instead of being sent again", async () => {
    const d = await setupDay("quiz_poll");
    await at(d, "17:59");
    // Simulate: the worker claimed the row and died before recording the result.
    d.h.clock.set(new Date((await firstInstance(d)).publish_at.getTime()));
    const { publishDue } = await import("../../src/services/runner.js");
    await publishDue(d.h.ctx);
    await d.h.ctx.db.updateTable("outbox").set({ status: "sending", lease_until: d.h.clock.now() }).where("purpose", "=", "question").execute();
    d.h.clock.set(new Date(d.h.clock.now().getTime() + 120_000));
    expect(await recoverStaleSending(d.h.ctx)).toBe(1);
    expect((await firstInstance(d)).state).toBe("uncertain");
    expect(polls(d)).toHaveLength(0);
  });

  it("after downtime: skips stale questions (admin alerted), closes overdue ones with original deadlines, and runs a missing report once", async () => {
    const d = await setupDay("quiz_poll", { students: 2 });
    await at(d, "18:00");
    const open = await firstInstance(d);
    // The process is down from 18:01 until 20:42.
    await at(d, "20:42");
    const insts = await d.h.ctx.db.selectFrom("question_instances").selectAll().where("day_plan_id", "=", await todayPlanId(d)).orderBy("slot").execute();
    expect(insts[0]!.state).toBe("closed");
    expect(insts[0]!.close_at.toISOString()).toBe(open.close_at.toISOString());
    // 18:30 .. 20:30 are all more than PUBLISH_GRACE_SECONDS late at 20:42.
    expect(insts.slice(1).every((i) => i.state === "skipped")).toBe(true);
    expect(adminMessages(d.h).filter((t) => t.includes("vaqtida yuborilmadi")).length).toBe(5);
    // Late answers to the overdue question are rejected.
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, student(0), open.poll_id!, 0));
    expect(await d.h.ctx.db.selectFrom("submissions").selectAll().execute()).toHaveLength(0);
    // Down again past the day end; on restart exactly one report is produced.
    await at(d, "23:30");
    await at(d, "23:31");
    expect(d.h.tg.messagesTo(CHAT).filter((m) => (m.text ?? "").includes("Bugungi natijalar"))).toHaveLength(1);
  });
});
