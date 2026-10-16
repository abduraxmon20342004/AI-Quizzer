/**
 * Seed data: registers a group (normally the bot does this itself when added), stores the sample lesson and
 * an example class list. In demo mode with the mock AI it also generates and approves sample questions.
 *
 *   npm run seed -- --chat-id -1001234567890 --title "7-A sinf"
 *   APP_MODE=demo AI_PROVIDER=mock npm run seed -- --chat-id -100123 --questions
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { buildApp } from "../app/build.js";
import { jobHandlers } from "../app/worker.js";
import { directDatabaseUrl, loadConfig } from "../config.js";
import { migrateUrl } from "../db/migrate.js";
import { GAME_TYPES } from "../domain/gameTypes.js";
import { InlineQueue } from "../jobs/queue.js";
import { ensureGroup } from "../services/groups.js";
import { createBatch } from "../services/generation.js";
import { addTextMaterial } from "../services/materials.js";
import { approveVersion } from "../services/questionBank.js";
import { importRoster } from "../services/roster.js";
import { FakeTelegram } from "../telegram/fakeTelegram.js";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i]!;
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") ? "true" : (process.argv[++i] ?? "true"));
}
const chatId = Number(args.get("chat-id"));
if (!Number.isSafeInteger(chatId) || chatId >= 0) {
  console.error('Usage: npm run seed -- --chat-id -100xxxxxxxxxx [--title "7-A"] [--questions]');
  process.exit(2);
}
const cfg = loadConfig();
const jobs = new InlineQueue();
// Seeding never talks to Telegram; the in-memory port only answers getMe.
const app = await buildApp(cfg, { tg: new FakeTelegram(), jobs });
jobs.handlers = jobHandlers(app.ctx);
await migrateUrl(directDatabaseUrl(cfg));
const ctx = app.ctx;
const adminId = cfg.BOT_ADMIN_IDS[0] ?? null;

const group = await ctx.db.transaction().execute((tx) => ensureGroup(ctx, tx, { id: chatId, title: args.get("title") ?? "Demo sinf" }));
const lesson = readFileSync(new URL("../../samples/lesson-js-arrays-uz.md", import.meta.url), "utf8");
const roster = readFileSync(new URL("../../samples/roster-uz.txt", import.meta.url), "utf8").split(/\r?\n/);
await ctx.db.transaction().execute(async (tx) => {
  const existing = await tx.selectFrom("materials").select("id").where("group_id", "=", group.id).where("title", "=", "JavaScript massivlari").executeTakeFirst();
  if (!existing) await addTextMaterial(ctx, tx, group.id, "JavaScript massivlari", lesson, adminId ?? 0);
  const added = await importRoster(ctx, tx, group.id, roster, adminId ?? 0);
  console.log(`roster: ${added} name(s) added`);
});
await jobs.drain();
console.log(`group #${group.id} (${chatId}) ready with the sample lesson`);

if (args.has("questions")) {
  if (!ctx.ai.isMock && ctx.ai.name === "none") {
    console.log("No AI provider configured - skipping question generation.");
  } else {
    for (const t of GAME_TYPES) {
      if (t === "picture_quiz") continue; // needs admin-provided pictures
      const res = await ctx.db.transaction().execute((tx) => createBatch(ctx, tx, { groupId: group.id, gameType: t, count: 6, actorId: adminId }));
      if (!res.ok) console.log(`${t}: ${res.reason}`);
    }
    await jobs.drain();
    if (ctx.ai.isMock) {
      const pending = await ctx.db.selectFrom("question_versions").select("id").where("group_id", "=", group.id).where("review_status", "=", "validated").execute();
      for (const p of pending) await ctx.db.transaction().execute((tx) => approveVersion(ctx, tx, p.id, adminId ?? 0));
      console.log(`demo: approved ${pending.length} mock questions`);
    } else {
      console.log("Questions generated and AI-reviewed; approve them in the admin panel (Savollar -> Tasdiqlash).");
    }
  }
}
await app.database.close();
