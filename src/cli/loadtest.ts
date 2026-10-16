/**
 * Load test: N students answer one question at (almost) the same moment, through the same update path as
 * long polling (processBatch -> router -> one DB transaction each). Telegram is faked, so the numbers are
 * LOCAL processing time only (DB + deterministic checks); real Telegram/network latency comes on top.
 *
 *   npm run loadtest                         # 100 students, poll + buttons
 *   npm run loadtest -- --students 300
 */
import "dotenv/config";
import type { Update } from "node-telegram-bot-api";
import { processBatch } from "../app/updateQueue.js";
import { atLocal } from "../domain/time.js";
import { addGroup, addLesson, callbackUpdate, closeSharedDb, createHarness, joinStudent, pollAnswerUpdate, prepareQuestions, settle, student } from "../sim/harness.js";
import { readFileSync } from "node:fs";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ""), process.argv[i + 1] ?? "");
const N = Number(args.get("students") ?? 100);
const CONCURRENCY = Number(args.get("concurrency") ?? 4);
const dbUrl = args.get("db") ?? process.env.SIM_DATABASE_URL ?? "postgres://gamebot:gamebot@localhost:54340/gamebot_sim";
const CHAT = -1009999;

function pct(xs: number[], p: number): string {
  const s = [...xs].sort((a, b) => a - b);
  return (s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0).toFixed(1);
}

async function run(label: string, date: string, gameType: "quiz_poll" | "emoji_puzzle") {
  const h = await createHarness({ databaseUrl: dbUrl, start: atLocal(date, "07:00", "Asia/Tashkent"), mode: "demo" });
  const groupId = await addGroup(h, CHAT, "Load test", { questionsPerDay: 1, endTime: "18:30" });
  for (let i = 0; i < N; i++) await joinStudent(h, CHAT, student(i));
  await addLesson(h, groupId, readFileSync(new URL("../../samples/lesson-js-arrays-uz.md", import.meta.url), "utf8"));
  await prepareQuestions(h, groupId, gameType, 2);
  h.clock.set(atLocal(date, "18:00", "Asia/Tashkent"));
  await settle(h);
  const inst = await h.ctx.db.selectFrom("question_instances").selectAll().where("state", "=", "open").executeTakeFirstOrThrow();
  h.clock.set(new Date(inst.publish_at.getTime() + 20_000));
  const updates: Update[] = Array.from({ length: N }, (_, i) =>
    gameType === "quiz_poll" ? pollAnswerUpdate(h, student(i), inst.poll_id!, i % 4) : callbackUpdate(h, student(i), CHAT, inst.message_id!, h.ctx.callbacks.encode("a", inst.id, i % 4)),
  );
  // Include 10% duplicate deliveries (Telegram retries / network repeats).
  for (let i = 0; i < N / 10; i++) updates.push(updates[i]!);
  const lat: number[] = [];
  const t0 = performance.now();
  await processBatch(updates, async (u) => {
    const s = performance.now();
    await h.router.handleUpdate(u);
    lat.push(performance.now() - s);
  }, CONCURRENCY);
  const wall = performance.now() - t0;
  const subs = await h.ctx.db.selectFrom("submissions").select(h.ctx.db.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
  const ledger = await h.ctx.db.selectFrom("score_ledger").select(h.ctx.db.fn.countAll<number>().as("n")).executeTakeFirstOrThrow();
  console.log(
    `${label}: ${updates.length} updates (${N} students + ${N / 10} duplicates) in ${wall.toFixed(0)} ms wall | per update p50 ${pct(lat, 0.5)} ms, p95 ${pct(lat, 0.95)} ms, p99 ${pct(lat, 0.99)} ms, max ${pct(lat, 1)} ms | submissions ${subs.n}, ledger rows ${ledger.n}` +
      (gameType === "emoji_puzzle" ? ` | callback acks ${h.tg.callbackAnswers.length}` : ""),
  );
}

console.log(`Load test against ${new URL(dbUrl).pathname.slice(1)}, ${CONCURRENCY} concurrent lanes, DB pool 10 (local processing only; Telegram faked, no network, no AI)\n`);
await run("quiz poll answers ", "2026-10-19", "quiz_poll");
await run("emoji button presses", "2026-10-24", "emoji_puzzle");
await closeSharedDb();
