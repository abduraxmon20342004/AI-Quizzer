import { sql } from "kysely";
import type { CallbackQuery, Update, User } from "node-telegram-bot-api";
import { MockAiProvider } from "../ai/mockProvider.js";
import { buildApp } from "../app/build.js";
import type { AppContext } from "../app/context.js";
import { createScheduler, jobHandlers } from "../app/worker.js";
import { createRouter } from "../bot/router.js";
import { VirtualClock } from "../clock.js";
import { loadConfig } from "../config.js";
import { createDatabase, type Database } from "../db/db.js";
import { migrate } from "../db/migrate.js";
import type { GameType } from "../domain/gameTypes.js";
import type { GroupSettings } from "../domain/settings.js";
import { InlineQueue } from "../jobs/queue.js";
import { createLogger } from "../logger.js";
import { getSettings, saveSettings } from "../services/groups.js";
import { reconcileGroup } from "../services/planner.js";
import { FakeTelegram } from "../telegram/fakeTelegram.js";

/**
 * Test / simulation harness: the real application with a fake Telegram, the mock AI provider, an inline job
 * queue and a virtual clock. Refuses to run unless the database name clearly marks a test/sim database.
 */
export const ADMIN_ID = 1001;
export const BOT_USER: User = { id: 999_000_001, is_bot: true, first_name: "GameBot", username: "test_game_bot" };

export function assertDisposableDb(url: string): void {
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/(_test|_sim)$/.test(name)) throw new Error(`refusing to wipe database "${name}": its name must end with _test or _sim`);
}

export async function resetDb(database: Database): Promise<void> {
  await migrate(database.pool);
  const tables = await sql<{ tablename: string }>`select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'`.execute(database.db);
  if (tables.rows.length) {
    await sql.raw(`truncate ${tables.rows.map((t) => `"${t.tablename}"`).join(", ")} restart identity cascade`).execute(database.db);
  }
}

export interface Harness {
  ctx: AppContext;
  tg: FakeTelegram;
  ai: MockAiProvider;
  jobs: InlineQueue;
  clock: VirtualClock;
  database: Database;
  router: ReturnType<typeof createRouter>;
  scheduler: ReturnType<typeof createScheduler>;
  nextUpdateId: () => number;
  close(): Promise<void>;
}

let sharedDb: { url: string; db: Database } | null = null;

export async function createHarness(opts: { databaseUrl: string; start: Date; env?: Record<string, string>; reset?: boolean; mode?: "test" | "demo" }): Promise<Harness> {
  assertDisposableDb(opts.databaseUrl);
  const cfg = loadConfig({
    APP_MODE: opts.mode ?? "test",
    DATABASE_URL: opts.databaseUrl,
    CALLBACK_SECRET: "test-callback-secret-0123456789",
    BOT_ADMIN_IDS: String(ADMIN_ID),
    AI_PROVIDER: "mock",
    LOG_LEVEL: "silent",
    REPORT_GRADING_WAIT_SECONDS: "60",
    ...opts.env,
  } as NodeJS.ProcessEnv);
  if (!sharedDb || sharedDb.url !== opts.databaseUrl) sharedDb = { url: opts.databaseUrl, db: createDatabase(opts.databaseUrl, 10) };
  const database = sharedDb.db;
  if (opts.reset !== false) await resetDb(database);
  const clock = new VirtualClock(opts.start);
  const tg = new FakeTelegram(BOT_USER);
  tg.now = () => clock.now();
  const ai = new MockAiProvider();
  const jobs = new InlineQueue();
  const built = await buildApp(cfg, { tg, ai, jobs, clock, database, log: createLogger("silent", false) });
  jobs.handlers = jobHandlers(built.ctx);
  let updateId = 1;
  return {
    ctx: built.ctx,
    tg,
    ai,
    jobs,
    clock,
    database,
    router: createRouter(built.ctx),
    scheduler: createScheduler(built.ctx, { bankPrepare: false }),
    nextUpdateId: () => updateId++,
    async close() {
      /* shared pool stays open for the next file; closed by closeSharedDb */
    },
  };
}

export async function closeSharedDb(): Promise<void> {
  if (sharedDb) await sharedDb.db.close();
  sharedDb = null;
}

export function student(i: number): User {
  return { id: 5000 + i, is_bot: false, first_name: `Talaba${i}` };
}

/** Bot is added to a group as admin; returns the group id. */
export async function addGroup(h: Harness, chatId: number, title: string, patch: Partial<GroupSettings> = {}): Promise<number> {
  await h.router.handleUpdate({
    update_id: h.nextUpdateId(),
    my_chat_member: {
      chat: { id: chatId, type: "supergroup", title },
      from: { id: ADMIN_ID, is_bot: false, first_name: "Teacher" },
      date: Math.floor(h.clock.now().getTime() / 1000),
      old_chat_member: { status: "left", user: BOT_USER },
      new_chat_member: { status: "administrator", user: BOT_USER },
    },
  } as unknown as Update);
  const g = await h.ctx.db.selectFrom("groups").select("id").where("chat_id", "=", chatId).executeTakeFirstOrThrow();
  if (Object.keys(patch).length) await patchSettings(h, g.id, patch);
  return g.id;
}

export async function patchSettings(h: Harness, groupId: number, patch: Partial<GroupSettings>): Promise<void> {
  await h.ctx.db.transaction().execute(async (tx) => {
    const cur = await getSettings(h.ctx, tx, groupId);
    const res = await saveSettings(h.ctx, tx, groupId, { ...cur, ...patch }, ADMIN_ID, "test");
    if (!res.ok) throw new Error(res.errors.join("; "));
    await reconcileGroup(h.ctx, tx, groupId);
  });
}

export async function joinStudent(h: Harness, chatId: number, user: User): Promise<void> {
  await h.router.handleUpdate({
    update_id: h.nextUpdateId(),
    chat_member: {
      chat: { id: chatId, type: "supergroup", title: "g" },
      from: user,
      date: Math.floor(h.clock.now().getTime() / 1000),
      old_chat_member: { status: "left", user },
      new_chat_member: { status: "member", user },
    },
  } as unknown as Update);
  let m = h.tg.members.get(chatId);
  if (!m) h.tg.members.set(chatId, (m = new Map()));
  m.set(user.id, "member");
}

export async function leaveStudent(h: Harness, chatId: number, user: User): Promise<void> {
  await h.router.handleUpdate({
    update_id: h.nextUpdateId(),
    chat_member: {
      chat: { id: chatId, type: "supergroup", title: "g" },
      from: user,
      date: Math.floor(h.clock.now().getTime() / 1000),
      old_chat_member: { status: "member", user },
      new_chat_member: { status: "left", user },
    },
  } as unknown as Update);
  h.tg.members.get(chatId)?.set(user.id, "left");
}

export function pollAnswerUpdate(h: Harness, user: User, pollId: string, option: number | null): Update {
  return { update_id: h.nextUpdateId(), poll_answer: { poll_id: pollId, user, option_ids: option === null ? [] : [option], option_persistent_ids: [] } } as unknown as Update;
}

export function callbackUpdate(h: Harness, user: User, chatId: number, messageId: number, data: string): Update {
  const cq: CallbackQuery = {
    id: `cq${h.nextUpdateId()}`,
    from: user,
    chat_instance: "ci",
    data,
    message: { message_id: messageId, date: 0, chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" } } as CallbackQuery["message"],
  };
  return { update_id: h.nextUpdateId(), callback_query: cq } as unknown as Update;
}

export function privateText(h: Harness, user: User, text: string): Update {
  return {
    update_id: h.nextUpdateId(),
    message: { message_id: h.nextUpdateId(), date: Math.floor(h.clock.now().getTime() / 1000), chat: { id: user.id, type: "private" }, from: user, text },
  } as unknown as Update;
}

/** Run the scheduler and background jobs until nothing is left to do at the current virtual time. */
export async function settle(h: Harness, rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await h.scheduler.tick(true);
    const ran = await h.jobs.drain();
    if (!ran && i > 0) break;
  }
}

/** Create, review and approve questions of one type through the real pipeline (mock AI). */
export async function prepareQuestions(h: Harness, groupId: number, gameType: GameType, count: number): Promise<number> {
  const { createBatch } = await import("../services/generation.js");
  const res = await h.ctx.db.transaction().execute((tx) => createBatch(h.ctx, tx, { groupId, gameType, count, actorId: ADMIN_ID }));
  if (!res.ok) throw new Error(res.reason);
  await h.jobs.drain();
  const { approveVersion } = await import("../services/questionBank.js");
  const pending = await h.ctx.db.selectFrom("question_versions").select("id").where("group_id", "=", groupId).where("game_type", "=", gameType).where("review_status", "=", "validated").execute();
  for (const p of pending) await h.ctx.db.transaction().execute((tx) => approveVersion(h.ctx, tx, p.id, ADMIN_ID));
  return pending.length;
}

export async function addLesson(h: Harness, groupId: number, text: string): Promise<number> {
  const { addTextMaterial } = await import("../services/materials.js");
  const id = await h.ctx.db.transaction().execute((tx) => addTextMaterial(h.ctx, tx, groupId, "JavaScript massivlari", text, ADMIN_ID));
  await h.jobs.drain();
  return id;
}
