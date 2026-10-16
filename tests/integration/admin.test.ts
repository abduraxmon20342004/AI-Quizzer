import { afterAll, describe, expect, it } from "vitest";
import { getSettings } from "../../src/services/groups.js";
import { ADMIN_ID, callbackUpdate, closeSharedDb, privateText, student } from "../../src/sim/harness.js";
import { setupDay } from "./setup.js";

afterAll(closeSharedDb);

const admin = { id: ADMIN_ID, is_bot: false, first_name: "Teacher" };
const groupAdminButNotBotAdmin = { id: 4242, is_bot: false, first_name: "GroupOwner" };

describe("admin panel permissions", () => {
  it("only BOT_ADMIN_IDS get the panel; Telegram group admins and students do not", async () => {
    const d = await setupDay("quiz_poll", { questions: 0 });
    await d.h.router.handleUpdate(privateText(d.h, admin, "/admin"));
    const panel = d.h.tg.messagesTo(ADMIN_ID).at(-1)!;
    expect(panel.text).toContain("Boshqaruv paneli");
    expect(panel.text).toContain(`Sinf ${-1001000000001}`);
    await d.h.router.handleUpdate(privateText(d.h, groupAdminButNotBotAdmin, "/admin"));
    expect(d.h.tg.messagesTo(4242).at(-1)?.text ?? "").not.toContain("Boshqaruv");
  });

  it("re-checks permission on every button: a non-admin pressing a (valid, signed) admin button changes nothing", async () => {
    const d = await setupDay("quiz_poll", { questions: 0 });
    const before = await getSettings(d.h.ctx, d.h.ctx.db, d.groupId);
    const data = d.h.ctx.callbacks.encode("m", "tg", "am"); // toggle auto-approval
    await d.h.router.handleUpdate(callbackUpdate(d.h, student(0), student(0).id, 5, data));
    expect(d.h.tg.callbackAnswers.at(-1)?.text).toBe("Ruxsat yo'q.");
    expect((await getSettings(d.h.ctx, d.h.ctx.db, d.groupId)).approvalMode).toBe(before.approvalMode);
    // The same button pressed by the bot admin works and confirms what was saved.
    await d.h.router.handleUpdate(callbackUpdate(d.h, admin, ADMIN_ID, 5, data));
    expect((await getSettings(d.h.ctx, d.h.ctx.db, d.groupId)).approvalMode).toBe("auto");
    const edited = d.h.tg.edits.at(-1);
    expect(String(edited?.payload.text ?? d.h.tg.messagesTo(ADMIN_ID).at(-1)?.text)).toMatch(/Saqlandi/);
  });

  it("rejects an impossible schedule with an explanation and saves a valid one with confirmation", async () => {
    const d = await setupDay("quiz_poll", { questions: 0 });
    await d.h.router.handleUpdate(callbackUpdate(d.h, admin, ADMIN_ID, 5, d.h.ctx.callbacks.encode("m", "se", "qn")));
    await d.h.router.handleUpdate(privateText(d.h, admin, "12"));
    const err = d.h.tg.messagesTo(ADMIN_ID).at(-1)!.text!;
    expect(err).toMatch(/Saqlanmadi/);
    expect(err).toMatch(/ko'pi bilan 6 ta savol/);
    expect((await getSettings(d.h.ctx, d.h.ctx.db, d.groupId)).questionsPerDay).toBe(6);
    await d.h.router.handleUpdate(privateText(d.h, admin, "4"));
    expect((await getSettings(d.h.ctx, d.h.ctx.db, d.groupId)).questionsPerDay).toBe(4);
    expect(d.h.tg.messagesTo(ADMIN_ID).at(-1)!.text).toMatch(/Saqlandi .*Kunlik savollar soni = 4/s);

    await d.h.router.handleUpdate(callbackUpdate(d.h, admin, ADMIN_ID, 5, d.h.ctx.callbacks.encode("m", "se", "st")));
    await d.h.router.handleUpdate(privateText(d.h, admin, "22:30"));
    expect(d.h.tg.messagesTo(ADMIN_ID).at(-1)!.text).toMatch(/Yarim tundan/);
    const audits = await d.h.ctx.db.selectFrom("audit_events").select("details").where("action", "=", "settings.update").where("actor_id", "=", ADMIN_ID).execute();
    const changes = audits.map((a) => (a.details as { change: string }).change);
    expect(changes.filter((c) => c.startsWith("qn="))).toEqual(["qn=4"]); // the rejected values were never saved
    expect(changes.some((c) => c.startsWith("st="))).toBe(false);
  });

  it("renders every admin screen without errors (smoke test over real data)", async () => {
    const d = await setupDay("find_mistake", { questions: 6 });
    const { createBatch } = await import("../../src/services/generation.js");
    await d.h.ctx.db.transaction().execute((tx) => createBatch(d.h.ctx, tx, { groupId: d.groupId, gameType: "emoji_puzzle", count: 3, actorId: ADMIN_ID }));
    await d.h.jobs.drain();
    const { at } = await import("./setup.js");
    await at(d, "18:00");
    const sid = (await d.h.ctx.db.selectFrom("students").select("id").executeTakeFirstOrThrow()).id;
    const screens: (string | number)[][] = [
      ["home"], ["groups"], ["st"], ["stl", 0], ["sd", sid], ["slk", sid, 0], ["rl", 0], ["mat"], ["q"], ["qg"], ["qgt", 0], ["qr", 0],
      ["qp"], ["sch"], ["pts"], ["ai"], ["gt"], ["gtd", 1], ["gto", 0], ["rep"], ["rv", 0], ["rc", 0], ["unc"], ["stop"], ["fin"],
    ];
    for (const [action, ...args] of screens) {
      const before = d.h.tg.edits.length + d.h.tg.sent.length;
      await d.h.router.handleUpdate(callbackUpdate(d.h, admin, ADMIN_ID, 5, d.h.ctx.callbacks.encode("m", String(action), ...args)));
      expect(d.h.tg.edits.length + d.h.tg.sent.length, `screen ${action}`).toBeGreaterThan(before);
      expect(d.h.tg.callbackAnswers.at(-1)?.text ?? "", `screen ${action}`).not.toMatch(/Noma'lum|Noto'g'ri/);
    }
  });

  it("imports the class list and links names to Telegram members only by explicit admin choice", async () => {
    const d = await setupDay("quiz_poll", { questions: 0, students: 2 });
    await d.h.router.handleUpdate(callbackUpdate(d.h, admin, ADMIN_ID, 5, d.h.ctx.callbacks.encode("m", "sim")));
    await d.h.router.handleUpdate(privateText(d.h, admin, "Talaba0\nAli Valiyev\nMadina Karimova"));
    const roster = await d.h.ctx.db.selectFrom("roster_entries").selectAll().orderBy("id").execute();
    expect(roster).toHaveLength(3);
    // Even an identical display name ("Talaba0") is not linked automatically.
    expect(roster.every((r) => r.student_id === null)).toBe(true);
    const s0 = await d.h.ctx.db.selectFrom("students").select("id").where("telegram_user_id", "=", student(0).id).executeTakeFirstOrThrow();
    await d.h.router.handleUpdate(callbackUpdate(d.h, admin, ADMIN_ID, 5, d.h.ctx.callbacks.encode("m", "slr", s0.id, roster[1]!.id)));
    const linked = await d.h.ctx.db.selectFrom("roster_entries").select(["full_name", "student_id"]).where("student_id", "is not", null).execute();
    expect(linked).toEqual([{ full_name: "Ali Valiyev", student_id: s0.id }]);
  });
});
