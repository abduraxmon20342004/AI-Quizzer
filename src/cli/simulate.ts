/**
 * Full day / week simulation without waiting for real time (demo mode: fake Telegram, mock AI, virtual clock,
 * real PostgreSQL). Runs the real scheduler, outbox, answer intake, grading jobs and reports.
 *
 *   npm run simulate -- --days 1            # one game day (Monday, quiz polls)
 *   npm run simulate -- --days 7            # Monday..Sunday incl. weekly report
 *   SIM_DATABASE_URL=postgres://.../gamebot_sim npm run simulate
 *
 * The database name must end with _sim or _test (it is wiped).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { DateTime } from "luxon";
import type { ContentOf } from "../domain/content.js";
import { parseContent } from "../domain/content.js";
import type { GameType } from "../domain/gameTypes.js";
import { addDays, atLocal, weekStartOf } from "../domain/time.js";
import { adminCorrectVerdict } from "../services/grading.js";
import { addPictureAsset } from "../services/materials.js";
import { importRoster, linkRoster, setStudentStatus } from "../services/roster.js";
import {
  ADMIN_ID,
  addGroup,
  addLesson,
  callbackUpdate,
  closeSharedDb,
  createHarness,
  joinStudent,
  leaveStudent,
  pollAnswerUpdate,
  prepareQuestions,
  privateText,
  student,
  type Harness,
} from "../sim/harness.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const days = Number(args.get("days") ?? 7);
const nStudents = Number(args.get("students") ?? 12);
const dbUrl = args.get("db") ?? process.env.SIM_DATABASE_URL ?? "postgres://gamebot:gamebot@localhost:54340/gamebot_sim";
const tz = "Asia/Tashkent";
const startDate = args.get("start") ?? weekStartOf(DateTime.now().setZone(tz).plus({ weeks: 1 }).toISODate()!);
const CHAT = -1001234567890;

let seed = 42;
function rand(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

type Action = { at: Date; label: string; run: () => Promise<void> };
const actions: Action[] = [];
const accuracy = Array.from({ length: nStudents }, (_, i) => (i === nStudents - 1 ? -1 : [0.95, 0.85, 0.75, 0.65, 0.55, 0.45][i % 6]!));
const stats = { answersSent: 0, lateAttempts: 0 };

async function ensureDb(url: string) {
  const u = new URL(url);
  const name = u.pathname.slice(1);
  u.pathname = "/postgres";
  const pg = (await import("pg")).default;
  const c = new pg.Client({ connectionString: u.toString() });
  await c.connect();
  const exists = await c.query("select 1 from pg_database where datname = $1", [name]);
  if (!exists.rowCount) await c.query(`create database "${name}"`);
  await c.end();
}

function planAnswers(h: Harness, inst: { id: number; game_type: string; publish_at: Date; close_at: Date; poll_id: string | null; message_id: number | null }, content: unknown, eligible: number[]) {
  const window = inst.close_at.getTime() - inst.publish_at.getTime();
  const type = inst.game_type as GameType;
  for (const i of eligible) {
    const acc = accuracy[i]!;
    if (acc < 0) continue; // this student never answers
    const user = student(i);
    const knows = rand() < acc;
    const late = rand() < 0.04;
    const at = new Date(inst.publish_at.getTime() + (late ? window + 30_000 : 15_000 + rand() * window * 0.6));
    if (late) stats.lateAttempts++;
    if (type === "quiz_poll" || type === "true_false") {
      const correct = type === "true_false" ? ((content as ContentOf<"true_false">).isTrue ? 0 : 1) : (content as ContentOf<"quiz_poll">).correctIndex;
      const n = type === "true_false" ? 2 : (content as ContentOf<"quiz_poll">).options.length;
      const option = knows ? correct : (correct + 1 + Math.floor(rand() * (n - 1))) % n;
      actions.push({ at, label: "poll", run: () => h.router.handleUpdate(pollAnswerUpdate(h, user, inst.poll_id!, option)) });
      // A duplicate delivery of the same update must not score twice.
      if (rand() < 0.1) actions.push({ at: new Date(at.getTime() + 1000), label: "dup", run: () => h.router.handleUpdate(pollAnswerUpdate(h, user, inst.poll_id!, option)) });
    } else if (type === "picture_quiz" || type === "emoji_puzzle") {
      const c = content as ContentOf<"emoji_puzzle">;
      const option = knows ? c.correctIndex : (c.correctIndex + 1) % 4;
      actions.push({ at, label: "button", run: () => h.router.handleUpdate(callbackUpdate(h, user, CHAT, inst.message_id ?? 1, h.ctx.callbacks.encode("a", inst.id, option))) });
    } else if (type === "find_mistake") {
      const c = content as ContentOf<"find_mistake">;
      const answer = knows ? (rand() < 0.5 ? c.fixedCode : c.fixedCode.replace(/;/g, "") + "\n") : i === 4 ? "???" : c.code;
      actions.push({
        at,
        label: "fix",
        run: async () => {
          await h.router.handleUpdate(privateText(h, user, `/start a_${inst.id}`));
          await h.router.handleUpdate(privateText(h, user, answer));
          await h.router.handleUpdate(callbackUpdate(h, user, user.id, 1, h.ctx.callbacks.encode("fc", inst.id)));
        },
      });
    } else if (type === "guess_word") {
      const c = content as ContentOf<"guess_word">;
      const stageKnown = knows ? 1 + Math.floor(rand() * 3) : 4;
      for (let stage = 1; stage <= Math.min(3, stageKnown); stage++) {
        const t0 = inst.publish_at.getTime() + ((stage - 1) * window) / 3;
        const when = new Date(t0 + 10_000 + rand() * (window / 3 - 20_000));
        const guess = stage === stageKnown ? (rand() < 0.3 ? c.answer.toUpperCase() : c.answer) : "noto'g'ri";
        actions.push({
          at: when,
          label: "guess",
          run: async () => {
            await h.router.handleUpdate(privateText(h, user, `/start a_${inst.id}`));
            await h.router.handleUpdate(privateText(h, user, guess));
          },
        });
      }
    }
    stats.answersSent++;
  }
}

async function main() {
  await ensureDb(dbUrl);
  const start = atLocal(startDate, "07:00", tz);
  const h = await createHarness({ databaseUrl: dbUrl, start, mode: "demo" });
  const lesson = readFileSync(new URL("../../samples/lesson-js-arrays-uz.md", import.meta.url), "utf8");
  console.log(`\n=== Simulation: ${days} day(s) from ${startDate} (${tz}), ${nStudents} students ===\n`);

  const groupId = await addGroup(h, CHAT, "7-A sinf", { topic: "JavaScript massivlari", level: "7-sinf o'quvchilari", approvalMode: "manual" });
  for (let i = 0; i < nStudents; i++) await joinStudent(h, CHAT, student(i));
  await h.ctx.db.transaction().execute(async (tx) => {
    await importRoster(h.ctx, tx, groupId, ["Madina Karimova", "Ali Valiyev", "Umar Saidov", "Zarina Tosheva", "Sardor Rahimov"], ADMIN_ID);
    const roster = await tx.selectFrom("roster_entries").select(["id", "full_name"]).orderBy("id").execute();
    const studs = await tx.selectFrom("students").select(["id"]).orderBy("id").execute();
    for (const [k, r] of roster.entries()) if (studs[k]) await linkRoster(h.ctx, tx, r.id, studs[k]!.id, ADMIN_ID);
  });
  await addLesson(h, groupId, lesson);
  for (let k = 0; k < 4; k++) {
    h.tg.files.set(`photo${k}`, { path: `photos/p${k}.jpg`, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) });
    await addPictureAsset(h.ctx, groupId, { file_id: `photo${k}` }, ["Olma, qizil meva", "Kompyuter klaviaturasi", "Kitoblar javoni", "Daraxt"][k]!, ADMIN_ID);
  }
  await h.jobs.drain();
  for (const t of ["quiz_poll", "find_mistake", "guess_word", "true_false", "picture_quiz", "emoji_puzzle"] as GameType[]) {
    const n = await prepareQuestions(h, groupId, t, 8);
    console.log(`prepared & approved ${n} ${t} questions`);
  }

  const timings: number[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(startDate, d);
    // Scripted events during the week.
    const events: Action[] = [];
    if (d === 2) events.push({ at: atLocal(date, "19:10", tz), label: "block", run: async () => void (await h.ctx.db.transaction().execute(async (tx) => setStudentStatus(h.ctx, tx, (await tx.selectFrom("students").select("id").where("telegram_user_id", "=", student(7).id).executeTakeFirstOrThrow()).id, "blocked", ADMIN_ID, "sim"))) });
    if (d === 3) events.push({ at: atLocal(date, "18:40", tz), label: "leave", run: () => leaveStudent(h, CHAT, student(8)) });
    if (d === 1) events.push({ at: atLocal(date, "19:45", tz), label: "ai-timeout", run: async () => h.ai.failNext("grade_answer", "timeout", 3) });
    actions.push(...events);

    for (let t = atLocal(date, "17:55", tz).getTime(); t <= atLocal(date, "21:05", tz).getTime(); t += 30_000) {
      // Student/admin actions due before this tick happen at their own (receipt) times.
      actions.sort((a, b) => a.at.getTime() - b.at.getTime());
      while (actions.length && actions[0]!.at.getTime() <= t) {
        const a = actions.shift()!;
        h.clock.set(a.at);
        const t0 = performance.now();
        await a.run();
        if (a.label !== "block" && a.label !== "leave" && a.label !== "ai-timeout") timings.push(performance.now() - t0);
      }
      h.clock.set(new Date(t));
      const before = new Set((await h.ctx.db.selectFrom("question_instances").select("id").where("state", "=", "open").execute()).map((r) => r.id));
      await h.scheduler.tick(true);
      await h.jobs.drain();
      const open = await h.ctx.db.selectFrom("question_instances").selectAll().where("state", "=", "open").execute();
      for (const inst of open) {
        if (before.has(inst.id)) continue;
        const v = await h.ctx.db.selectFrom("question_versions").select("content").where("id", "=", inst.question_version_id!).executeTakeFirstOrThrow();
        const eligible = (await h.ctx.db.selectFrom("students").select(["telegram_user_id"]).where("group_id", "=", groupId).execute()).map((s) => s.telegram_user_id - 5000);
        planAnswers(h, inst, parseContent(inst.game_type as GameType, v.content), eligible);
      }
    }
    // Next morning: the admin resolves pending reviews (report gets edited, never re-sent).
    h.clock.set(atLocal(addDays(date, 1), "08:00", tz));
    const pending = await h.ctx.db.selectFrom("submissions").select("id").where("verdict", "=", "needs_review").execute();
    for (const p of pending) await adminCorrectVerdict(h.ctx, p.id, "incorrect", "sim: o'qituvchi tekshirdi", ADMIN_ID);
    if (pending.length) console.log(`[${date}] admin resolved ${pending.length} answer(s) needing review`);
    await h.scheduler.tick(true);
    await h.jobs.drain();
    await h.scheduler.tick(true);
  }
  // Weekly report (Sunday 18:00 by default).
  if (days >= 7) {
    h.clock.set(atLocal(addDays(startDate, 6), "18:01", tz));
    await h.scheduler.tick(true);
    await h.scheduler.tick(true);
  }

  // ---- transcript
  console.log("\n=== Group chat transcript (questions shortened, reports in full) ===");
  for (const m of h.tg.messagesTo(CHAT)) {
    const local = DateTime.fromJSDate(m.at, { zone: tz }).toFormat("ccc HH:mm");
    const text = (m.text ?? "").replace(/<[^>]+>/g, "");
    const isReport = text.startsWith("📊") || text.startsWith("🏆") || /^\(\d+\/\d+\)/.test(text);
    if (isReport) console.log(`\n[${local}] ${m.method}\n${text}\n`);
    else console.log(`[${local}] ${m.method}: ${text.split("\n").slice(0, 2).join(" | ").slice(0, 110)}`);
  }
  const reportEdits = h.tg.edits.filter((e) => e.method === "editMessageText" && e.chatId === CHAT);
  for (const e of reportEdits) console.log(`\n[edit of message ${e.messageId}]\n${String(e.payload.text).replace(/<[^>]+>/g, "")}`);

  const counts = await h.ctx.db.selectFrom("question_instances").select(["state", h.ctx.db.fn.countAll<number>().as("n")]).groupBy("state").execute();
  const ledger = await h.ctx.db.selectFrom("score_ledger").select(["kind", h.ctx.db.fn.countAll<number>().as("n"), h.ctx.db.fn.sum<number>("points").as("points")]).groupBy("kind").execute();
  const reports = await h.ctx.db.selectFrom("reports").select(["kind", "period_key", "status", "has_pending", "last_edited_at"]).orderBy("id").execute();
  const dupes = await h.ctx.db.selectFrom("score_ledger").select("award_key").groupBy("award_key").having(h.ctx.db.fn.countAll(), ">", 1).execute();
  timings.sort((a, b) => a - b);
  const pct = (p: number) => timings[Math.min(timings.length - 1, Math.floor(p * timings.length))]?.toFixed(1);
  console.log("\n=== Summary ===");
  console.log("question instances:", Object.fromEntries(counts.map((c) => [c.state, Number(c.n)])));
  console.log("ledger:", ledger.map((l) => `${l.kind}: ${l.n} entries, ${l.points} pts`).join("; "));
  console.log("reports:", reports.map((r) => `${r.kind} ${r.period_key} ${r.status}${r.has_pending ? " (pending)" : ""}${r.last_edited_at ? " edited" : ""}`).join(" | "));
  const outbox = await h.ctx.db.selectFrom("outbox").select(["status", h.ctx.db.fn.countAll<number>().as("n")]).groupBy("status").execute();
  console.log("outbox:", Object.fromEntries(outbox.map((o) => [o.status, Number(o.n)])), "(fake Telegram validates HTML like the real API)");
  console.log(`planned student answers: ${stats.answersSent}, deliberately late: ${stats.lateAttempts}, duplicate award keys: ${dupes.length}`);
  console.log(`local processing per student action (ms): p50=${pct(0.5)} p95=${pct(0.95)} max=${timings[timings.length - 1]?.toFixed(1)} (n=${timings.length}; fake Telegram, no network)`);
  const callbackAcks = h.tg.callbackAnswers.map((a) => a.text);
  console.log(`callback acknowledgements: ${callbackAcks.length} (sample: ${[...new Set(callbackAcks)].slice(0, 4).join(" / ")})`);
  await closeSharedDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeSharedDb();
  process.exit(1);
});
