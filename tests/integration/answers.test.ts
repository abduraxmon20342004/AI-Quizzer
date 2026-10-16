import { afterAll, describe, expect, it } from "vitest";
import { setStudentStatus } from "../../src/services/roster.js";
import { callbackUpdate, closeSharedDb, joinStudent, leaveStudent, pollAnswerUpdate, privateText, student } from "../../src/sim/harness.js";
import { at, CHAT, contentOf, ledgerFor, openInstance, setupDay, studentId } from "./setup.js";

afterAll(closeSharedDb);

describe("quiz polls", () => {
  it("locks the first non-empty answer; duplicates, retractions and re-votes never score twice", async () => {
    const d = await setupDay("quiz_poll");
    await at(d, "18:00");
    const inst = (await openInstance(d))!;
    const { content } = await contentOf(d, inst.id);
    const correct = (content as { correctIndex: number }).correctIndex;
    const u = student(0);
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, u, inst.poll_id!, correct));
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, u, inst.poll_id!, correct)); // duplicate delivery
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, u, inst.poll_id!, null)); // retraction
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, u, inst.poll_id!, (correct + 1) % 4)); // new vote
    const subs = await d.h.ctx.db.selectFrom("submissions").selectAll().where("instance_id", "=", inst.id).execute();
    expect(subs).toHaveLength(1);
    expect(subs[0]!.option_index).toBe(correct);
    const ledger = await ledgerFor(d);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.award_key).toBe(`answer:${inst.id}:${await studentId(d, 0)}`);
    // No score message is posted after an answer.
    expect(d.h.tg.messagesTo(CHAT).filter((m) => (m.text ?? "").includes("ball"))).toHaveLength(0);
  });

  it("awards atomically under concurrent duplicate updates", async () => {
    const d = await setupDay("quiz_poll");
    await at(d, "18:00");
    const inst = (await openInstance(d))!;
    const correct = ((await contentOf(d, inst.id)).content as { correctIndex: number }).correctIndex;
    await Promise.all(Array.from({ length: 25 }, () => d.h.router.handleUpdate(pollAnswerUpdate(d.h, student(1), inst.poll_id!, correct))));
    expect(await d.h.ctx.db.selectFrom("submissions").selectAll().where("instance_id", "=", inst.id).execute()).toHaveLength(1);
    expect(await ledgerFor(d)).toHaveLength(1);
    const totals = await d.h.ctx.db.selectFrom("score_totals").selectAll().where("period", "=", "day").execute();
    expect(totals).toHaveLength(1);
  });

  it("rejects late answers using the server receive time", async () => {
    const d = await setupDay("quiz_poll");
    await at(d, "18:00");
    const inst = (await openInstance(d))!;
    d.h.clock.set(new Date(inst.close_at.getTime() + (d.h.ctx.cfg.POLL_ANSWER_GRACE_SECONDS + 1) * 1000));
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, student(0), inst.poll_id!, 0));
    expect(await d.h.ctx.db.selectFrom("submissions").selectAll().execute()).toHaveLength(0);
  });

  it("discovers new human members as eligible automatically; ignores bots", async () => {
    const d = await setupDay("quiz_poll", { students: 1 });
    await at(d, "18:00");
    const inst = (await openInstance(d))!;
    const newcomer = { id: 7777, is_bot: false, first_name: "Yangi" };
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, newcomer, inst.poll_id!, 0));
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, { id: 8888, is_bot: true, first_name: "Bot" }, inst.poll_id!, 0));
    const studs = await d.h.ctx.db.selectFrom("students").selectAll().where("group_id", "=", d.groupId).execute();
    expect(studs.map((s) => s.telegram_user_id).sort()).toEqual([5000, 7777]);
    expect(studs.every((s) => s.status === "eligible")).toBe(true);
  });

  it("rejects blocked and departed students but keeps their earlier valid points", async () => {
    const d = await setupDay("quiz_poll");
    await at(d, "18:00");
    let inst = (await openInstance(d))!;
    let correct = ((await contentOf(d, inst.id)).content as { correctIndex: number }).correctIndex;
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, student(2), inst.poll_id!, correct));
    await d.h.ctx.db.transaction().execute(async (tx) => setStudentStatus(d.h.ctx, tx, await studentId(d, 2), "blocked", 1001, "test"));
    await leaveStudent(d.h, CHAT, student(3));
    await at(d, "18:30");
    inst = (await openInstance(d))!;
    correct = ((await contentOf(d, inst.id)).content as { correctIndex: number }).correctIndex;
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, student(2), inst.poll_id!, correct));
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, student(3), inst.poll_id!, correct));
    const subs = await d.h.ctx.db.selectFrom("submissions").selectAll().where("instance_id", "=", inst.id).execute();
    expect(subs).toHaveLength(0);
    const ledger = await ledgerFor(d);
    expect(ledger.reduce((a, l) => a + l.points, 0)).toBeGreaterThan(0); // earlier answer kept
    // Rejoining through a real membership event makes the student eligible again.
    await joinStudent(d.h, CHAT, student(3));
    await d.h.router.handleUpdate(pollAnswerUpdate(d.h, student(3), inst.poll_id!, correct));
    expect(await d.h.ctx.db.selectFrom("submissions").selectAll().where("instance_id", "=", inst.id).execute()).toHaveLength(1);
  });
});

describe("answer buttons (emoji / picture)", () => {
  it("first choice is final, acknowledgements never reveal correctness, forged and expired buttons are rejected", async () => {
    const d = await setupDay("emoji_puzzle");
    await at(d, "18:00");
    const inst = (await openInstance(d))!;
    const correct = ((await contentOf(d, inst.id)).content as { correctIndex: number }).correctIndex;
    const press = (i: number, opt: number, data?: string) => d.h.router.handleUpdate(callbackUpdate(d.h, student(i), CHAT, inst.message_id!, data ?? d.h.ctx.callbacks.encode("a", inst.id, opt)));
    await press(0, correct);
    await press(1, (correct + 1) % 4);
    await press(0, (correct + 2) % 4);
    await press(2, 0, `a:${inst.id}:0:forgedsig0`);
    const answers = d.h.tg.callbackAnswers.map((a) => a.text);
    expect(answers[0]).toBe(answers[1]); // same ack for right and wrong
    expect(answers[2]).toMatch(/allaqachon/);
    expect(answers[3]).toMatch(/ishlamaydi/);
    const subs = await d.h.ctx.db.selectFrom("submissions").selectAll().where("instance_id", "=", inst.id).orderBy("id").execute();
    expect(subs.map((s) => s.option_index)).toEqual([correct, (correct + 1) % 4]);
    // The shared group keyboard is never edited per student.
    expect(d.h.tg.edits.filter((e) => e.messageId === inst.message_id)).toHaveLength(0);
    await at(d, "18:10", 1);
    await press(3, correct);
    expect(d.h.tg.callbackAnswers.at(-1)?.text).toMatch(/Vaqt tugadi/);
  });

  it("isolates groups: a button of one group's question pressed in another chat is rejected", async () => {
    const a = await setupDay("emoji_puzzle");
    const b = await setupDay("emoji_puzzle", { h: a.h, chatId: -1002, questions: 4 });
    await at(a, "18:00");
    const instA = (await openInstance(a))!;
    await a.h.router.handleUpdate(callbackUpdate(a.h, student(0), -1002, 1, a.h.ctx.callbacks.encode("a", instA.id, 0)));
    expect(a.h.tg.callbackAnswers.at(-1)?.text).toMatch(/ishlamaydi/);
    expect(await a.h.ctx.db.selectFrom("submissions").selectAll().execute()).toHaveLength(0);
    // Questions are generated only from each group's own materials.
    const { createBatch } = await import("../../src/services/generation.js");
    await a.h.ctx.db.updateTable("materials").set({ active: false }).where("group_id", "=", b.groupId).execute();
    const res = await a.h.ctx.db.transaction().execute((tx) => createBatch(a.h.ctx, tx, { groupId: b.groupId, gameType: "emoji_puzzle", count: 3, actorId: 1001 }));
    expect(res.ok).toBe(false);
  });
});

describe("no student score features", () => {
  it("has no /score, /top or join commands, never posts live scores, and never messages students unprompted", async () => {
    const d = await setupDay("quiz_poll");
    await at(d, "18:00");
    for (const cmd of ["/score", "/top", "/join", "/pause"]) await d.h.router.handleUpdate(privateText(d.h, student(0), cmd));
    const replies = d.h.tg.messagesTo(student(0).id).map((m) => m.text ?? "");
    expect(replies).toHaveLength(4);
    expect(replies.every((r) => !/\d+\s*ball/.test(r))).toBe(true);
    // Other students who never wrote to the bot received nothing privately.
    expect(d.h.tg.messagesTo(student(1).id)).toHaveLength(0);
  });
});
