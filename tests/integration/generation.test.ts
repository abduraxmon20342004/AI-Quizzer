import { afterAll, describe, expect, it } from "vitest";
import { createBatch, handleBankPrepare } from "../../src/services/generation.js";
import { addTelegramDocument } from "../../src/services/materials.js";
import { assignPlan } from "../../src/services/questionBank.js";
import { ADMIN_ID, closeSharedDb, patchSettings, settle } from "../../src/sim/harness.js";
import { makeDocx, makePdf } from "../fixtures.js";
import { adminMessages, at, setupDay, todayPlanId } from "./setup.js";

afterAll(closeSharedDb);

describe("question preparation", () => {
  it("splits batches 80/20 with rounding up, stores source references, and labels extra questions", async () => {
    const d = await setupDay("quiz_poll", { questions: 0 });
    const res = await d.h.ctx.db.transaction().execute((tx) => createBatch(d.h.ctx, tx, { groupId: d.groupId, gameType: "quiz_poll", count: 6, actorId: ADMIN_ID }));
    expect(res.ok).toBe(true);
    const batch = await d.h.ctx.db.selectFrom("generation_batches").selectAll().executeTakeFirstOrThrow();
    expect([batch.source_count, batch.extra_count]).toEqual([5, 1]);
    await d.h.jobs.drain();
    const versions = await d.h.ctx.db.selectFrom("question_versions").selectAll().where("review_status", "in", ["validated", "approved"]).execute();
    expect(versions.length).toBeGreaterThanOrEqual(5);
    for (const v of versions.filter((x) => x.origin === "source")) {
      expect((v.source_refs as unknown[]).length).toBeGreaterThan(0);
      expect(v.source_excerpt.length).toBeGreaterThan(10);
    }
    for (const v of versions.filter((x) => x.origin === "extra")) expect(v.source_refs).toEqual([]);
    // Default approval mode is manual: nothing is approved until the admin approves it.
    expect(versions.every((v) => v.review_status === "validated")).toBe(true);
    await settle(d.h); // alerts go out through the outbox
    expect(adminMessages(d.h).some((t) => t.includes("tasdiqlashingizni kutmoqda"))).toBe(true);
  });

  it("auto-publish mode approves only items that passed every gate", async () => {
    const d = await setupDay("true_false", { questions: 0, settings: { approvalMode: "auto" } });
    await d.h.ctx.db.transaction().execute((tx) => createBatch(d.h.ctx, tx, { groupId: d.groupId, gameType: "true_false", count: 6, actorId: ADMIN_ID }));
    await d.h.jobs.drain();
    const v = await d.h.ctx.db.selectFrom("question_versions").select("review_status").execute();
    expect(v.filter((x) => x.review_status === "approved").length).toBeGreaterThan(0);
    expect(v.some((x) => x.review_status === "validated")).toBe(false);
  });

  it("regenerates items the reviewer rejects, with a bounded number of attempts", async () => {
    const d = await setupDay("quiz_poll", { questions: 0 });
    d.h.ai.rejectAllReviews = true;
    await d.h.ctx.db.transaction().execute((tx) => createBatch(d.h.ctx, tx, { groupId: d.groupId, gameType: "quiz_poll", count: 3, actorId: ADMIN_ID }));
    await d.h.jobs.drain(100);
    const batch = await d.h.ctx.db.selectFrom("generation_batches").selectAll().executeTakeFirstOrThrow();
    expect(batch.status).toBe("partial");
    expect(batch.attempts).toBeLessThanOrEqual(3);
    expect(d.h.ai.calls.filter((c) => c.task === "generate_questions").length).toBeLessThanOrEqual(3);
    expect(await d.h.ctx.db.selectFrom("question_versions").select("id").where("review_status", "in", ["approved", "validated"]).execute()).toHaveLength(0);
  });

  it("does not reuse recently used questions", async () => {
    const d = await setupDay("quiz_poll", { questions: 8, settings: { questionsPerDay: 3, endTime: "19:30" } });
    const today = await todayPlanId(d);
    const used = await d.h.ctx.db.selectFrom("question_instances").select("question_version_id").where("day_plan_id", "=", today).execute();
    expect(new Set(used.map((u) => u.question_version_id)).size).toBe(3);
    // Next Monday's plan must avoid the questions published today.
    for (const t of ["18:00", "18:30", "19:00", "19:15"]) await at(d, t);
    const nextMonday = { ...d, date: "2026-10-26" };
    await patchSettings(d.h, d.groupId, { bankBufferDays: 8 });
    await at(nextMonday, "07:00");
    const next = await d.h.ctx.db
      .selectFrom("question_instances as qi")
      .innerJoin("day_plans as dp", "dp.id", "qi.day_plan_id")
      .innerJoin("question_versions as v", "v.id", "qi.question_version_id")
      .select("v.question_id")
      .where("dp.local_date", "=", "2026-10-26")
      .execute();
    const todayQ = await d.h.ctx.db.selectFrom("question_instances as qi").innerJoin("question_versions as v", "v.id", "qi.question_version_id").select("v.question_id").where("qi.day_plan_id", "=", today).execute();
    const overlap = next.filter((n) => todayQ.some((t) => t.question_id === n.question_id));
    expect(overlap).toHaveLength(0);
  });

  it("asks the admin for pictures before a picture day instead of switching the type", async () => {
    const d = await setupDay("picture_quiz", { questions: 0, pictures: 0 });
    await handleBankPrepare(d.h.ctx, { groupId: d.groupId });
    await d.h.jobs.drain();
    await settle(d.h);
    expect(adminMessages(d.h).some((t) => t.includes("Rasmli savollar uchun tasdiqlangan rasm yo'q"))).toBe(true);
    const plan = await d.h.ctx.db.selectFrom("day_plans").selectAll().where("id", "=", await todayPlanId(d)).executeTakeFirstOrThrow();
    expect(plan.game_type).toBe("picture_quiz");
  });

  it("fills unassigned slots once questions are approved", async () => {
    const d = await setupDay("emoji_puzzle", { questions: 0 });
    const plan = await todayPlanId(d);
    expect((await d.h.ctx.db.selectFrom("question_instances").select("question_version_id").where("day_plan_id", "=", plan).execute()).every((x) => x.question_version_id === null)).toBe(true);
    const { prepareQuestions } = await import("../../src/sim/harness.js");
    await prepareQuestions(d.h, d.groupId, "emoji_puzzle", 6);
    await d.h.ctx.db.transaction().execute((tx) => assignPlan(d.h.ctx, tx, plan));
    expect((await d.h.ctx.db.selectFrom("question_instances").select("question_version_id").where("day_plan_id", "=", plan).execute()).filter((x) => x.question_version_id).length).toBeGreaterThan(0);
  });
});

describe("materials", () => {
  it("extracts uploaded PDF/DOCX files once, reuses identical files, and reports bad files privately to the admin", async () => {
    const d = await setupDay("quiz_poll", { questions: 0 });
    const lesson = "push metodi massiv oxiriga yangi element qo'shadi. pop metodi esa massivning oxirgi elementini olib tashlaydi va uni qaytaradi. indexOf metodi qiymat topilmasa -1 qaytaradi.";
    d.h.tg.files.set("pdf1", { path: "docs/a.pdf", bytes: makePdf([lesson]) });
    d.h.tg.files.set("pdf2", { path: "docs/b.pdf", bytes: makePdf([lesson]) });
    d.h.tg.files.set("docx1", { path: "docs/c.docx", bytes: await makeDocx([lesson]) });
    d.h.tg.files.set("bad", { path: "docs/virus.pdf", bytes: Buffer.from("MZ\x90\x00 not a pdf") });
    d.h.tg.files.set("macro", { path: "docs/m.docx", bytes: await makeDocx([lesson], true) });
    const up = (id: string, name: string) => addTelegramDocument(d.h.ctx, d.groupId, { file_id: id, file_name: name, file_size: 1000 }, ADMIN_ID);
    expect((await up("pdf1", "dars.pdf")).ok).toBe(true);
    expect((await up("pdf2", "dars-nusxa.pdf")).ok).toBe(true);
    expect((await up("docx1", "dars.docx")).ok).toBe(true);
    expect(await up("bad", "virus.pdf")).toMatchObject({ ok: false });
    expect(await up("macro", "m.docx")).toMatchObject({ ok: false });
    expect(await addTelegramDocument(d.h.ctx, d.groupId, { file_id: "pdf1", file_name: "big.pdf", file_size: 50 * 1024 * 1024 }, ADMIN_ID)).toMatchObject({ ok: false });
    await d.h.jobs.drain();
    const mats = await d.h.ctx.db.selectFrom("materials").select(["title", "status", "extraction_method", "content_hash"]).where("kind", "!=", "text").orderBy("id").execute();
    expect(mats.map((m) => m.status)).toEqual(["ready", "ready", "ready"]);
    expect(mats[1]!.extraction_method).toMatch(/^reused:/);
    expect(mats[0]!.content_hash).toBe(mats[1]!.content_hash);
    const sections = await d.h.ctx.db.selectFrom("material_sections as s").innerJoin("materials as m", "m.id", "s.material_id").select(["s.ref"]).where("m.kind", "=", "pdf").execute();
    expect(sections.every((s) => s.ref.startsWith("p."))).toBe(true);
    // Students never received any material content.
    for (let i = 0; i < 5; i++) expect(d.h.tg.messagesTo(5000 + i)).toHaveLength(0);
  });

  it("reports scanned PDFs as unreadable instead of inventing text", async () => {
    const d = await setupDay("quiz_poll", { questions: 0 });
    d.h.tg.files.set("scan", { path: "docs/scan.pdf", bytes: makePdf(["", ""]) });
    await addTelegramDocument(d.h.ctx, d.groupId, { file_id: "scan", file_name: "scan.pdf" }, ADMIN_ID);
    await d.h.jobs.drain();
    await settle(d.h);
    const m = await d.h.ctx.db.selectFrom("materials").selectAll().where("kind", "=", "pdf").executeTakeFirstOrThrow();
    expect(m.status).toBe("failed");
    expect(await d.h.ctx.db.selectFrom("material_sections").selectAll().where("material_id", "=", m.id).execute()).toHaveLength(0);
    expect(adminMessages(d.h).some((t) => t.includes("skanerlangan"))).toBe(true);
  });
});
