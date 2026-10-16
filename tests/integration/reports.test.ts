import { afterAll, describe, expect, it } from "vitest";
import type { GameType } from "../../src/domain/gameTypes.js";
import { addDays } from "../../src/domain/time.js";
import { applyStreakBonuses } from "../../src/services/participation.js";
import { stopToday, finishAndReport } from "../../src/services/planner.js";
import { importRoster } from "../../src/services/roster.js";
import { invalidateInstance } from "../../src/services/scoring.js";
import { runDayEnds } from "../../src/services/reports.js";
import { closeSharedDb, joinStudent, prepareQuestions, settle, student } from "../../src/sim/harness.js";
import { answerOpen, at, CHAT, ledgerFor, openInstance, playDay, setupDay, studentId, type Day } from "./setup.js";

afterAll(closeSharedDb);

const COMPACT = { questionsPerDay: 1, endTime: "18:30" };
const groupTexts = (d: Day) => d.h.tg.messagesTo(CHAT).map((m) => m.text ?? "");
const reportsSent = (d: Day) => d.h.tg.messagesTo(CHAT).filter((m) => (m.text ?? "").includes("Bugungi natijalar"));

async function weekSetup(): Promise<Day> {
  const d = await setupDay("quiz_poll", { students: 4, questions: 3, settings: COMPACT });
  for (const t of ["find_mistake", "guess_word", "true_false", "emoji_puzzle"] as GameType[]) await prepareQuestions(d.h, d.groupId, t, 3);
  // No picture assets in this group: Friday is switched to true/false by the admin beforehand.
  await d.h.ctx.db.transaction().execute(async (tx) => (await import("../../src/services/planner.js")).overrideDayType(d.h.ctx, tx, d.groupId, "2026-10-23", "true_false", 1001));
  await settle(d.h);
  return d;
}

describe("daily report", () => {
  it("publishes exactly one report per day including zero scorers but not unidentified roster names", async () => {
    const d = await setupDay("quiz_poll", { students: 3, settings: COMPACT });
    await d.h.ctx.db.transaction().execute((tx) => importRoster(d.h.ctx, tx, d.groupId, ["Hech Qachon Kelmagan"], 1001));
    await playDay(d, { 0: true, 1: false });
    const reports = reportsSent(d);
    expect(reports).toHaveLength(1);
    const text = reports[0]!.text!;
    expect(text).toMatch(/Talaba0<\/b>: \d+ ball, 1 to'g'ri/);
    expect(text).toMatch(/Talaba1<\/b>: 0 ball, 1 xato/);
    expect(text).toMatch(/Talaba2<\/b>: 0 ball, 1 javobsiz/);
    expect(text).not.toContain("Hech Qachon");
    // Re-running the day end (e.g. after a crash) never produces a second report.
    await runDayEnds(d.h.ctx);
    await at(d, "19:00");
    await at(d, "23:00");
    expect(reportsSent(d)).toHaveLength(1);
    expect(await d.h.ctx.db.selectFrom("reports").selectAll().execute()).toHaveLength(1);
  });

  it("marks pending results and edits the same report message when grading settles", async () => {
    const d = await setupDay("find_mistake", { students: 2, settings: COMPACT });
    await at(d, "18:00");
    const inst = (await openInstance(d))!;
    d.h.ai.failNext("grade_answer", "timeout", 3);
    const { privateText, callbackUpdate } = await import("../../src/sim/harness.js");
    const u = student(0);
    await d.h.router.handleUpdate(privateText(d.h, u, `/start a_${inst.id}`));
    await d.h.router.handleUpdate(privateText(d.h, u, "const x = 1; // boshqacha yechim"));
    await d.h.router.handleUpdate(callbackUpdate(d.h, u, u.id, 1, d.h.ctx.callbacks.encode("fc", inst.id)));
    await at(d, "18:10", 5);
    await at(d, "18:30", 0);
    await at(d, "18:32", 0); // grading wait over -> report with pending marker
    const first = reportsSent(d);
    expect(first).toHaveLength(1);
    expect(first[0]!.text).toMatch(/1 tekshirilmoqda/);
    expect(first[0]!.text).toMatch(/tekshirilmoqda — natijalar yangilanadi/);
    const sub = await d.h.ctx.db.selectFrom("submissions").select("id").executeTakeFirstOrThrow();
    const { adminCorrectVerdict } = await import("../../src/services/grading.js");
    await adminCorrectVerdict(d.h.ctx, sub.id, "correct", "teng kuchli yechim", 1001);
    await at(d, "18:40");
    expect(reportsSent(d)).toHaveLength(1); // still one report message
    const edit = d.h.tg.edits.find((e) => e.method === "editMessageText" && e.messageId === first[0]!.messageId);
    expect(edit).toBeDefined();
    expect(String(edit!.payload.text)).toMatch(/Talaba0<\/b>: \d+ ball, 1 to'g'ri/);
    expect(String(edit!.payload.text)).not.toMatch(/tekshirilmoqda/);
  });

  it("splits a large roster into numbered parts of the same report and edits the right part", async () => {
    const d = await setupDay("quiz_poll", { students: 0, settings: COMPACT });
    for (let i = 0; i < 160; i++) await joinStudent(d.h, CHAT, { id: 9000 + i, is_bot: false, first_name: `Juda uzun ism familiya ${i} o'g'li` });
    await playDay(d, {});
    const parts = d.h.tg.messagesTo(CHAT).filter((m) => /^\(\d+\/\d+\)/.test(m.text ?? ""));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.text!.length <= 4096)).toBe(true);
    const msgs = await d.h.ctx.db.selectFrom("report_messages").selectAll().execute();
    expect(msgs).toHaveLength(parts.length);
    expect(msgs.every((m) => m.message_id !== null)).toBe(true);
  });
});

describe("stop today / finish and report", () => {
  it("Stop Today cancels the active question with no points, cancels the rest, keeps earlier results; one report at the end", async () => {
    const d = await setupDay("quiz_poll", { students: 3 });
    await at(d, "18:00");
    await answerOpen(d, 0, true);
    await at(d, "18:30");
    await answerOpen(d, 0, true);
    await answerOpen(d, 1, true);
    const before = (await ledgerFor(d)).reduce((a, l) => a + l.points, 0);
    expect(before).toBeGreaterThan(0);
    const r = await stopToday(d.h.ctx, d.groupId, 1001, false);
    expect(r).toMatchObject({ ok: true, canceledActive: 1, canceledScheduled: 4 });
    const ledger = await ledgerFor(d);
    const reversals = ledger.filter((l) => l.kind === "reversal");
    expect(reversals).toHaveLength(2);
    const firstPoints = ledger.filter((l) => l.kind === "answer").slice(0, 1)[0]!.points;
    expect(ledger.reduce((a, l) => a + l.points, 0)).toBe(firstPoints);
    await at(d, "19:00");
    expect(reportsSent(d)).toHaveLength(0); // the report still waits for the configured end
    await at(d, "21:00");
    await at(d, "21:01");
    const reports = reportsSent(d);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.text).toMatch(/to'xtatildi/);
    expect(reports[0]!.text).toMatch(/Talaba1<\/b>: 0 ball/); // the canceled question is not counted as wrong or unanswered
    expect(reports[0]!.text).not.toMatch(/Talaba1<\/b>: 0 ball, .*xato/);
  });

  it("Finish and Report closes the open question now and reports immediately", async () => {
    const d = await setupDay("true_false", { students: 2 });
    await at(d, "18:00");
    await answerOpen(d, 0, true);
    await finishAndReport(d.h.ctx, d.groupId, 1001);
    await at(d, "18:01");
    await at(d, "18:01", 10);
    await at(d, "18:03"); // within REPORT_GRADING_WAIT nothing is pending, report goes out
    expect(reportsSent(d)).toHaveLength(1);
    const insts = await d.h.ctx.db.selectFrom("question_instances").select(["state"]).where("group_id", "=", d.groupId).execute();
    expect(insts.filter((i) => i.state === "closed")).toHaveLength(1);
  });
});

describe("weekly report, streaks and ties", () => {
  it("uses the Monday-Sunday week, shares the title on a full tie, gives streak bonuses once and treats canceled days as neutral", async () => {
    const d = await weekSetup();
    const day = (k: number): Day => ({ ...d, date: addDays("2026-10-19", k) });
    // Mon, Tue: students 0 and 1 answer correctly, 2 answers wrong, 3 never.
    await playDay(day(0), { 0: true, 1: true, 2: false });
    await playDay(day(1), { 0: true, 1: true, 2: false });
    // Wed: the admin stops the day before any question -> neutral for everyone.
    await at(day(2), "17:00");
    await stopToday(d.h.ctx, d.groupId, 1001, false);
    await at(day(2), "18:31");
    await playDay(day(3), { 0: true, 1: true, 2: false });
    await playDay(day(4), { 0: true, 1: true, 2: false });
    await playDay(day(5), { 0: true, 1: true });
    const bonuses = (await ledgerFor(d)).filter((l) => l.kind === "streak_bonus");
    // 5 qualifying days (Mon, Tue, Thu, Fri, Sat; Wed neutral) for students 0 and 1 -> one bonus each on Saturday.
    expect(bonuses.map((b) => b.local_date)).toEqual(["2026-10-24", "2026-10-24"]);
    expect(new Set(bonuses.map((b) => b.student_id))).toEqual(new Set([await studentId(d, 0), await studentId(d, 1)]));
    // Student 2 skipped Saturday (missed) -> no bonus.
    await d.h.ctx.db.transaction().execute((tx) => applyStreakBonuses(d.h.ctx, tx, d.groupId, "2026-10-19"));
    expect((await ledgerFor(d)).filter((l) => l.kind === "streak_bonus")).toHaveLength(2);

    // Weekly report on Sunday 18:00 (Sunday has no games).
    await at(day(6), "17:59");
    expect(groupTexts(d).some((t) => t.includes("Haftalik"))).toBe(false);
    await at(day(6), "18:00");
    const weekly = groupTexts(d).filter((t) => t.includes("Haftalik natijalar"));
    expect(weekly).toHaveLength(1);
    expect(weekly[0]).toMatch(/Hafta chempionlari: <b>Talaba0<\/b>, <b>Talaba1<\/b>/);
    expect(weekly[0]).toMatch(/1\. <b>Talaba0<\/b>[\s\S]*1\. <b>Talaba1<\/b>/);
    const champs = await d.h.ctx.db.selectFrom("champion_periods").selectAll().execute();
    expect(champs).toHaveLength(2);

    // Next Monday belongs to a new week: the old weekly report is not touched by new answers.
    await prepareQuestions(d.h, d.groupId, "quiz_poll", 2);
    await playDay(day(7), { 2: true });
    await at(day(7), "19:00");
    expect(groupTexts(d).filter((t) => t.includes("Haftalik natijalar"))).toHaveLength(1);
    const weekly2 = await d.h.ctx.db.selectFrom("reports").selectAll().where("kind", "=", "weekly").execute();
    expect(weekly2).toHaveLength(1);
    expect(weekly2[0]!.needs_refresh).toBe(false);

    // Invalidating Monday's question makes Monday neutral -> the streak drops to 4 -> bonuses revoked by audited reversals.
    const monInst = await d.h.ctx.db
      .selectFrom("question_instances as qi")
      .innerJoin("day_plans as dp", "dp.id", "qi.day_plan_id")
      .select("qi.id")
      .where("dp.local_date", "=", "2026-10-19")
      .where("qi.opened_at", "is not", null)
      .executeTakeFirstOrThrow();
    const { recalcFromDate } = await import("../../src/services/participation.js");
    await d.h.ctx.db.transaction().execute(async (tx) => {
      await invalidateInstance(d.h.ctx, tx, monInst.id, 1001, "noto'g'ri savol");
      await recalcFromDate(d.h.ctx, tx, d.groupId, "2026-10-19");
    });
    const after = await ledgerFor(d);
    expect(after.filter((l) => l.award_key.startsWith("streak-revoke:"))).toHaveLength(2);
    expect((await d.h.ctx.db.selectFrom("streak_awards").selectAll().where("revoked_at", "is", null).execute()).length).toBe(0);
    await at(day(7), "19:05");
    // The original weekly report message is edited (not re-sent) with the corrected standings.
    expect(groupTexts(d).filter((t) => t.includes("Haftalik natijalar"))).toHaveLength(1);
    expect(d.h.tg.edits.some((e) => String(e.payload.text ?? "").includes("Haftalik natijalar"))).toBe(true);
  });
});
