import { z } from "zod";

/**
 * Environment configuration. Secrets live only here (read from env) and are never logged.
 * APP_MODE separates real operation from demo/test: the mock AI provider and the fake
 * Telegram client are refused in production.
 */
const csvIds = z
  .string()
  .default("")
  .transform((s, ctx) => {
    const ids: number[] = [];
    for (const part of s.split(",").map((p) => p.trim()).filter(Boolean)) {
      const n = Number(part);
      if (!Number.isSafeInteger(n) || n <= 0) {
        ctx.addIssue({ code: "custom", message: `BOT_ADMIN_IDS contains an invalid Telegram user id: ${part}` });
        return z.NEVER;
      }
      ids.push(n);
    }
    return ids;
  });

const bool = z
  .string()
  .optional()
  .transform((v) => v === "1" || v?.toLowerCase() === "true");

const EnvSchema = z.object({
  APP_MODE: z.enum(["production", "demo", "test"]).default("production"),
  PROCESS_ROLE: z.enum(["all", "bot", "worker"]).default("all"),
  BOT_TOKEN: z.string().default(""),
  BOT_ADMIN_IDS: csvIds,
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(2).max(100).default(10),
  /**
   * Neon: DATABASE_URL may be the pooled endpoint (host contains "-pooler"); migrations and the pg-boss job
   * queue then use this direct (non-pooler) endpoint, because they rely on session-level advisory locks.
   */
  DATABASE_DIRECT_URL: z.string().optional(),

  TELEGRAM_MODE: z.enum(["polling", "webhook"]).default("polling"),
  WEBHOOK_URL: z.string().url().optional(),
  WEBHOOK_SECRET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,256}$/, "WEBHOOK_SECRET: 16-256 chars of A-Z a-z 0-9 _ -")
    .optional(),
  WEBHOOK_PATH: z.string().default("/telegram/webhook"),
  /** Defaults to PORT (injected by Railway and similar platforms), else 8080. */
  HTTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
  HTTP_HOST: z.string().default("0.0.0.0"),
  /** Injected by Railway when the service has a public domain; used as the default WEBHOOK_URL. */
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  RAILWAY_ENVIRONMENT: z.string().optional(),
  TELEGRAM_SEND_TIMEOUT_MS: z.coerce.number().int().min(2000).default(15000),

  CALLBACK_SECRET: z.string().min(16, "CALLBACK_SECRET must be at least 16 characters"),

  DEFAULT_TIMEZONE: z.string().default("Asia/Tashkent"),
  DEFAULT_LANGUAGE: z.enum(["uz", "ru", "en"]).default("uz"),

  AI_PROVIDER: z.enum(["openai", "anthropic", "mock", "none"]).default("openai"),
  OPENAI_API_KEY: z.string().optional(),
  /** Optional: OpenAI-compatible base URL (e.g. EU data residency endpoint). */
  OPENAI_BASE_URL: z.string().url().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Model ids default per provider: openai -> gpt-6-luna, anthropic -> claude-opus-5-5. */
  AI_GENERATION_MODEL: z.string().optional(),
  AI_REVIEW_MODEL: z.string().optional(),
  AI_GRADING_MODEL: z.string().optional(),
  AI_VISION_MODEL: z.string().optional(),
  AI_GENERATION_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  AI_REVIEW_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  AI_GRADING_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  AI_REFUSAL_FALLBACK: z.enum(["default", "off"]).default("default"),
  AI_TIMEOUT_MS: z.coerce.number().int().min(5000).default(180000),
  AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(6).default(3),
  /** JSON map model -> {input, output} USD per 1M tokens; overrides the built-in table. */
  AI_PRICING_JSON: z.string().optional(),
  AI_GENERATION_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  AI_GRADING_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  EXTRACT_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),

  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).max(20 * 1024 * 1024).default(10 * 1024 * 1024),
  PDF_MAX_PAGES: z.coerce.number().int().min(1).max(500).default(80),
  EXTRACT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60000),
  OCR_ENABLED: bool,
  OCR_LANGS: z.string().default("uzb+uzb_cyrl+eng+rus"),
  OCR_MAX_PAGES: z.coerce.number().int().min(1).max(50).default(10),
  OCR_TIMEOUT_MS: z.coerce.number().int().min(5000).default(180000),
  OCR_LANG_PATH: z.string().optional(),
  RAW_FILE_RETENTION_DAYS: z.coerce.number().int().min(0).default(30),

  TICK_INTERVAL_MS: z.coerce.number().int().min(200).default(1000),
  PUBLISH_GRACE_SECONDS: z.coerce.number().int().min(10).default(120),
  POLL_ANSWER_GRACE_SECONDS: z.coerce.number().int().min(0).max(120).default(15),
  REPORT_GRADING_WAIT_SECONDS: z.coerce.number().int().min(0).max(1800).default(120),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  LOG_PRETTY: bool,
});

export type Env = z.infer<typeof EnvSchema>;

type ModelKey = "AI_GENERATION_MODEL" | "AI_REVIEW_MODEL" | "AI_GRADING_MODEL" | "AI_VISION_MODEL";

export interface AppConfig extends Omit<Env, ModelKey | "HTTP_PORT"> {
  isProduction: boolean;
  HTTP_PORT: number;
  AI_GENERATION_MODEL: string;
  AI_REVIEW_MODEL: string;
  AI_GRADING_MODEL: string;
  AI_VISION_MODEL: string;
}

/** Default model per provider (each verified against the provider's official model docs, 2026-10). */
export const DEFAULT_MODELS: Record<Env["AI_PROVIDER"], string> = {
  openai: "gpt-6-luna",
  anthropic: "claude-opus-5-5",
  mock: "mock",
  none: "none",
};

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  // `KEY=` lines in .env (as in .env.example) mean "not set", not "set to an empty string".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const env = parsed.data;
  const model = DEFAULT_MODELS[env.AI_PROVIDER];
  const cfg: AppConfig = {
    ...env,
    AI_GENERATION_MODEL: env.AI_GENERATION_MODEL || model,
    AI_REVIEW_MODEL: env.AI_REVIEW_MODEL || model,
    AI_GRADING_MODEL: env.AI_GRADING_MODEL || model,
    AI_VISION_MODEL: env.AI_VISION_MODEL || model,
    HTTP_PORT: env.HTTP_PORT ?? env.PORT ?? 8080,
    // Railway: the generated/custom public domain is the webhook host unless WEBHOOK_URL is given explicitly.
    WEBHOOK_URL: env.WEBHOOK_URL ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : undefined),
    isProduction: env.APP_MODE === "production",
  };
  assertConfigConsistency(cfg);
  return cfg;
}

/** Connection used for migrations and the pg-boss queue (direct endpoint when a pooler is in front). */
export function directDatabaseUrl(cfg: Pick<AppConfig, "DATABASE_URL" | "DATABASE_DIRECT_URL">): string {
  return cfg.DATABASE_DIRECT_URL || cfg.DATABASE_URL;
}

export function assertConfigConsistency(cfg: AppConfig): void {
  const problems: string[] = [];
  if (cfg.isProduction) {
    if (!cfg.BOT_TOKEN) problems.push("BOT_TOKEN is required in production");
    if (cfg.BOT_ADMIN_IDS.length === 0) problems.push("BOT_ADMIN_IDS must list at least one Telegram user id");
    if (cfg.AI_PROVIDER === "mock") problems.push("AI_PROVIDER=mock is only allowed when APP_MODE is demo or test");
    if (cfg.AI_PROVIDER === "anthropic" && !cfg.ANTHROPIC_API_KEY)
      problems.push("ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic");
    if (cfg.AI_PROVIDER === "openai" && !cfg.OPENAI_API_KEY) problems.push("OPENAI_API_KEY is required when AI_PROVIDER=openai");
  }
  if (/-pooler\./.test(cfg.DATABASE_URL) && !cfg.DATABASE_DIRECT_URL) {
    problems.push(
      "DATABASE_URL is a Neon pooled endpoint (-pooler). Also set DATABASE_DIRECT_URL to the direct endpoint: " +
        "migrations and the job queue need session-level advisory locks, which PgBouncer transaction pooling does not keep.",
    );
  }
  if (cfg.DATABASE_DIRECT_URL && /-pooler\./.test(cfg.DATABASE_DIRECT_URL)) {
    problems.push("DATABASE_DIRECT_URL must be the direct Neon endpoint (host without '-pooler')");
  }
  if (cfg.TELEGRAM_MODE === "webhook") {
    if (!cfg.WEBHOOK_URL) problems.push("WEBHOOK_URL is required when TELEGRAM_MODE=webhook (on Railway: generate a public domain for the service)");
    if (!cfg.WEBHOOK_SECRET) problems.push("WEBHOOK_SECRET is required when TELEGRAM_MODE=webhook");
  }
  if (problems.length) throw new Error(`Invalid configuration:\n${problems.join("\n")}`);
}
