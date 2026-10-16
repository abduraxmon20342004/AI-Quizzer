import "dotenv/config";
import type { Update } from "node-telegram-bot-api";
import { buildApp } from "./app/build.js";
import { createHttpServer } from "./app/http.js";
import { processBatch } from "./app/updateQueue.js";
import { createScheduler, jobHandlers, onDeadLetter } from "./app/worker.js";
import { ALLOWED_UPDATES, createRouter } from "./bot/router.js";
import { directDatabaseUrl, loadConfig } from "./config.js";
import { migrateUrl } from "./db/migrate.js";

/**
 * Entry point. PROCESS_ROLE=all runs the bot (updates) and the worker (scheduler + background jobs) in one
 * process - enough for a small deployment. TELEGRAM_MODE selects long polling (development) or webhook (VPS);
 * the two are never active at once (polling deletes the webhook first; webhook mode never polls).
 */
const cfg = loadConfig();
const app = await buildApp(cfg);
const { ctx, database, boss, pollingApi } = app;
const log = ctx.log;
for (const w of cfg.warnings) log.warn(w);
if (cfg.RAILWAY_ENVIRONMENT && cfg.TELEGRAM_MODE === "polling") {
  // During a Railway deploy old and new instances overlap; two long-polling consumers get 409 Conflict for a few
  // seconds (the poll loop backs off and recovers). Webhook mode avoids it.
  log.warn("Running on Railway in polling mode - generate a public domain and set WEBHOOK_SECRET to use the webhook");
}

await migrateUrl(directDatabaseUrl(cfg), (m) => log.info(m));
const runBot = cfg.PROCESS_ROLE !== "worker";
const runWorker = cfg.PROCESS_ROLE !== "bot";
const router = createRouter(ctx);
const abort = new AbortController();
let pollLoop: Promise<void> | null = null;

const server = createHttpServer(ctx, {
  webhook: runBot && cfg.TELEGRAM_MODE === "webhook" ? { path: cfg.WEBHOOK_PATH, secret: cfg.WEBHOOK_SECRET!, handle: router.handleUpdate } : null,
  workerExpected: runWorker,
});
server.listen(cfg.HTTP_PORT, cfg.HTTP_HOST, () => log.info({ port: cfg.HTTP_PORT }, "http server listening"));

if (runWorker) {
  if (boss) {
    await boss.start();
    await boss.work(
      jobHandlers(ctx),
      {
        "material.extract": cfg.EXTRACT_CONCURRENCY,
        "questions.generate": cfg.AI_GENERATION_CONCURRENCY,
        "questions.review": cfg.AI_GENERATION_CONCURRENCY,
        "answers.grade": cfg.AI_GRADING_CONCURRENCY,
        "asset.review": 1,
        "bank.prepare": 1,
      },
      (job) => onDeadLetter(ctx, job),
    );
  }
}
const scheduler = runWorker ? createScheduler(ctx) : null;
scheduler?.start(cfg.TICK_INTERVAL_MS);

if (runBot && pollingApi) {
  if (cfg.TELEGRAM_MODE === "webhook") {
    await pollingApi.setWebhook({ url: `${cfg.WEBHOOK_URL!.replace(/\/$/, "")}${cfg.WEBHOOK_PATH}`, secret_token: cfg.WEBHOOK_SECRET!, allowed_updates: ALLOWED_UPDATES, max_connections: 20 });
    log.info("webhook registered");
  } else {
    await pollingApi.deleteWebhook({ drop_pending_updates: false });
    pollLoop = (async () => {
      let offset = 0;
      let backoff = 1000;
      while (!abort.signal.aborted) {
        try {
          const updates: Update[] = await pollingApi.getUpdates({ offset, timeout: 30, allowed_updates: ALLOWED_UPDATES }, abort.signal);
          backoff = 1000;
          if (!updates.length) continue;
          // Offset advances only after the whole batch was processed (at-least-once; handlers are idempotent).
          // 4 lanes measured best with a 10-connection pool (see README load test); same-user updates stay ordered.
          await processBatch(updates, router.handleUpdate, 4, (u, err) => log.error({ updateId: u.update_id, err: (err as Error).message }, "update failed"));
          offset = updates[updates.length - 1]!.update_id + 1;
        } catch (err) {
          if (abort.signal.aborted) break;
          log.warn({ err: (err as Error).message, backoff }, "getUpdates failed");
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(60_000, backoff * 2);
        }
      }
    })();
    log.info({ bot: ctx.bot.username }, "long polling started");
  }
}

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, "shutting down");
  abort.abort();
  await pollLoop?.catch(() => {});
  await scheduler?.stop();
  await boss?.stop().catch(() => {});
  await new Promise((r) => server.close(() => r(null)));
  await database.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
