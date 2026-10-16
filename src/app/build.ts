import { AiPricing } from "../ai/budget.js";
import { AnthropicProvider } from "../ai/anthropicProvider.js";
import { MockAiProvider } from "../ai/mockProvider.js";
import { OpenAIProvider } from "../ai/openaiProvider.js";
import { DisabledAiProvider, type AiProvider } from "../ai/provider.js";
import { systemClock, type Clock } from "../clock.js";
import { directDatabaseUrl, type AppConfig } from "../config.js";
import { createDatabase, type Database } from "../db/db.js";
import { PgBossQueue, type JobQueue } from "../jobs/queue.js";
import { createLogger, type Logger } from "../logger.js";
import { registerReportHandlers } from "../services/reports.js";
import { registerRunnerHandlers } from "../services/runner.js";
import { CallbackCodec } from "../telegram/callbackData.js";
import type { TelegramPort } from "../telegram/port.js";
import { createRealTelegram } from "../telegram/realTelegram.js";
import { Metrics, type AppContext } from "./context.js";

export interface BuildOverrides {
  tg?: TelegramPort;
  ai?: AiProvider;
  jobs?: JobQueue;
  clock?: Clock;
  log?: Logger;
  database?: Database;
}

export interface BuiltApp {
  ctx: AppContext;
  database: Database;
  boss: PgBossQueue | null;
  pollingApi: ReturnType<typeof createRealTelegram>["pollingApi"] | null;
}

export function createAi(cfg: AppConfig): AiProvider {
  if (cfg.AI_PROVIDER === "mock") {
    if (cfg.isProduction) throw new Error("mock AI provider is not allowed in production");
    return new MockAiProvider();
  }
  if (cfg.AI_PROVIDER === "openai") {
    if (!cfg.OPENAI_API_KEY) return new DisabledAiProvider();
    return new OpenAIProvider(cfg.OPENAI_API_KEY, { maxRetries: 1, ...(cfg.OPENAI_BASE_URL ? { baseURL: cfg.OPENAI_BASE_URL } : {}) });
  }
  if (cfg.AI_PROVIDER === "none" || !cfg.ANTHROPIC_API_KEY) return new DisabledAiProvider();
  return new AnthropicProvider(cfg.ANTHROPIC_API_KEY, { refusalFallback: cfg.AI_REFUSAL_FALLBACK === "default", maxRetries: 1 });
}

export async function buildApp(cfg: AppConfig, o: BuildOverrides = {}): Promise<BuiltApp> {
  const log = o.log ?? createLogger(cfg.LOG_LEVEL, cfg.LOG_PRETTY);
  const database = o.database ?? createDatabase(cfg.DATABASE_URL, cfg.DATABASE_POOL_MAX);
  let tg = o.tg;
  let pollingApi: BuiltApp["pollingApi"] = null;
  if (!tg) {
    if (!cfg.BOT_TOKEN) throw new Error("BOT_TOKEN is required");
    const real = createRealTelegram(cfg.BOT_TOKEN, { sendTimeoutMs: cfg.TELEGRAM_SEND_TIMEOUT_MS });
    tg = real.port;
    pollingApi = real.pollingApi;
  }
  const me = await tg.getMe();
  let boss: PgBossQueue | null = null;
  let jobs = o.jobs;
  if (!jobs) {
    // pg-boss needs a session-stable connection: the direct endpoint when a Neon pooler is in front.
    boss = new PgBossQueue(directDatabaseUrl(cfg), log);
    jobs = boss;
  }
  registerRunnerHandlers();
  registerReportHandlers();
  const ctx: AppContext = {
    cfg,
    db: database.db,
    clock: o.clock ?? systemClock,
    log,
    tg,
    ai: o.ai ?? createAi(cfg),
    pricing: new AiPricing(cfg.AI_PRICING_JSON),
    jobs,
    callbacks: new CallbackCodec(cfg.CALLBACK_SECRET),
    bot: { id: me.id, username: me.username ?? "bot" },
    metrics: new Metrics(),
  };
  return { ctx, database, boss, pollingApi };
}
