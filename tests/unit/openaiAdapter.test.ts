import { describe, expect, it } from "vitest";
import { AiPricing } from "../../src/ai/budget.js";
import { OpenAIProvider } from "../../src/ai/openaiProvider.js";
import { AiPermanentError } from "../../src/ai/provider.js";
import { GradeSchema } from "../../src/ai/schemas.js";
import { loadConfig } from "../../src/config.js";
import { isNeonPooler, poolConfig } from "../../src/db/db.js";

/** Exercises the real OpenAI SDK (Responses API) with a fake HTTP layer: no network, no key. */
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; json: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), json: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-request-id": "req_test" } });
  }) as typeof fetch;
  return { f, calls };
}

const response = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "resp_1",
  object: "response",
  created_at: 1,
  status: "completed",
  model: "gpt-6-luna-2026-09-22",
  output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content }],
  usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } },
  incomplete_details: null,
  error: null,
  ...extra,
});

const req = {
  task: "grade_answer" as const,
  model: "gpt-6-luna",
  effort: "medium" as const,
  system: "sys",
  content: [
    { type: "text" as const, text: "grade this" },
    { type: "image" as const, mediaType: "image/png" as const, base64: "iVBORw0KGgo=" },
  ],
  schema: GradeSchema,
  maxTokens: 2000,
  timeoutMs: 10_000,
  input: {},
};

describe("OpenAI adapter (gpt-6-luna, Responses API)", () => {
  it("sends a strict JSON-schema request with reasoning effort and parses the result", async () => {
    const { f, calls } = fakeFetch(response([{ type: "output_text", text: JSON.stringify({ verdict: "incorrect", reason: "different word" }), annotations: [] }]));
    const p = new OpenAIProvider("sk-test", { maxRetries: 0, fetch: f });
    const res = await p.structured(req);
    expect(res.data).toEqual({ verdict: "incorrect", reason: "different word" });
    expect(res.inputTokens).toBe(200);
    expect(res.outputTokens).toBe(40);
    const sent = calls[0]!;
    expect(sent.url).toMatch(/\/v1\/responses$/);
    expect(sent.json).toMatchObject({ model: "gpt-6-luna", instructions: "sys", reasoning: { effort: "medium" }, max_output_tokens: 2000, store: false });
    const format = (sent.json.text as { format: { type: string; strict: boolean; schema: { properties: object; additionalProperties: boolean } } }).format;
    expect(format.type).toBe("json_schema");
    expect(format.strict).toBe(true);
    expect(format.schema.additionalProperties).toBe(false);
    expect(Object.keys(format.schema.properties).sort()).toEqual(["reason", "verdict"]);
    const content = ((sent.json.input as { content: { type: string; image_url?: string }[] }[])[0]!).content;
    expect(content.map((c) => c.type)).toEqual(["input_text", "input_image"]);
    expect(content[1]!.image_url).toMatch(/^data:image\/png;base64,/);
  });

  it("treats refusals, truncated and invalid output as permanent errors", async () => {
    const refusal = new OpenAIProvider("sk-test", { maxRetries: 0, fetch: fakeFetch(response([{ type: "refusal", refusal: "can't help" }])).f });
    await expect(refusal.structured(req)).rejects.toBeInstanceOf(AiPermanentError);
    const truncated = new OpenAIProvider("sk-test", { maxRetries: 0, fetch: fakeFetch(response([{ type: "output_text", text: '{"verdict":"corr', annotations: [] }], { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } })).f });
    await expect(truncated.structured(req)).rejects.toMatchObject({ code: "max_tokens" });
    const invalid = new OpenAIProvider("sk-test", { maxRetries: 0, fetch: fakeFetch(response([{ type: "output_text", text: '{"verdict":"maybe","reason":"x"}', annotations: [] }])).f });
    await expect(invalid.structured(req)).rejects.toMatchObject({ code: "invalid_output" });
  });

  it("maps 400/401 to permanent errors and keeps 429/5xx retryable", async () => {
    const bad = new OpenAIProvider("sk-test", { maxRetries: 0, fetch: fakeFetch({ error: { message: "bad", type: "invalid_request_error" } }, 400).f });
    await expect(bad.structured(req)).rejects.toBeInstanceOf(AiPermanentError);
    const busy = new OpenAIProvider("sk-test", { maxRetries: 0, fetch: fakeFetch({ error: { message: "slow down", type: "rate_limit" } }, 429).f });
    expect(await busy.structured(req).catch((e: unknown) => e)).not.toBeInstanceOf(AiPermanentError);
  });

  it("prices gpt-6-luna (also dated snapshots) at $0.10 / $0.50 per 1M tokens", () => {
    const p = new AiPricing();
    expect(p.cost("gpt-6-luna", 1_000_000, 1_000_000)).toBeCloseTo(0.6);
    expect(p.cost("gpt-6-luna-2026-09-22", 1_000_000, 0)).toBeCloseTo(0.1);
  });
});

describe("configuration", () => {
  const base = { DATABASE_URL: "postgres://u:p@localhost/db", CALLBACK_SECRET: "x".repeat(20), APP_MODE: "test" };
  it("defaults to OpenAI gpt-6-luna for all AI roles; Anthropic stays selectable", () => {
    const c = loadConfig(base as NodeJS.ProcessEnv);
    expect(c.AI_PROVIDER).toBe("openai");
    expect([c.AI_GENERATION_MODEL, c.AI_REVIEW_MODEL, c.AI_GRADING_MODEL, c.AI_VISION_MODEL]).toEqual(["gpt-6-luna", "gpt-6-luna", "gpt-6-luna", "gpt-6-luna"]);
    expect(loadConfig({ ...base, AI_PROVIDER: "anthropic" } as NodeJS.ProcessEnv).AI_GRADING_MODEL).toBe("claude-opus-5-5");
    expect(() => loadConfig({ ...base, APP_MODE: "production", BOT_TOKEN: "t", BOT_ADMIN_IDS: "1" } as NodeJS.ProcessEnv)).toThrow(/OPENAI_API_KEY/);
  });

  it("treats empty KEY= lines from .env.example as unset", () => {
    const c = loadConfig({ ...base, WEBHOOK_URL: "", WEBHOOK_SECRET: "", OPENAI_BASE_URL: "", AI_GRADING_MODEL: "", DATABASE_DIRECT_URL: "" } as NodeJS.ProcessEnv);
    expect(c.WEBHOOK_URL).toBeUndefined();
    expect(c.AI_GRADING_MODEL).toBe("gpt-6-luna");
  });

  it("on Railway listens on PORT and uses the Railway domain as the webhook URL", () => {
    const c = loadConfig({ ...base, PORT: "7123", RAILWAY_PUBLIC_DOMAIN: "student-bot-production.up.railway.app", TELEGRAM_MODE: "webhook", WEBHOOK_SECRET: "s".repeat(32) } as NodeJS.ProcessEnv);
    expect(c.HTTP_PORT).toBe(7123);
    expect(c.WEBHOOK_URL).toBe("https://student-bot-production.up.railway.app");
    expect(loadConfig(base as NodeJS.ProcessEnv).HTTP_PORT).toBe(8080);
    expect(loadConfig({ ...base, PORT: "7123", HTTP_PORT: "9000" } as NodeJS.ProcessEnv).HTTP_PORT).toBe(9000);
    // Webhook requested but no domain yet (e.g. Railway before "Generate Domain"): keep working with polling.
    const noDomain = loadConfig({ ...base, TELEGRAM_MODE: "webhook", WEBHOOK_SECRET: "s".repeat(32) } as NodeJS.ProcessEnv);
    expect(noDomain.TELEGRAM_MODE).toBe("polling");
    expect(noDomain.warnings.join()).toMatch(/Generate Domain/);
    const noSecret = loadConfig({ ...base, TELEGRAM_MODE: "webhook", RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app" } as NodeJS.ProcessEnv);
    expect(noSecret.TELEGRAM_MODE).toBe("polling");
    expect(noSecret.warnings.join()).toMatch(/WEBHOOK_SECRET/);
    const ready = loadConfig({ ...base, TELEGRAM_MODE: "webhook", RAILWAY_PUBLIC_DOMAIN: "x.up.railway.app", WEBHOOK_SECRET: "s".repeat(32) } as NodeJS.ProcessEnv);
    expect(ready.TELEGRAM_MODE).toBe("webhook");
    expect(ready.warnings).toEqual([]);
  });

  it("connects to Railway Postgres: plain private URL inside Railway, encrypted (self-signed) via the public proxy", () => {
    const internal = poolConfig("postgresql://postgres:pw@postgres.railway.internal:5432/railway", 10);
    expect(new URL(internal.connectionString!).searchParams.has("sslmode")).toBe(false);
    const proxy = poolConfig("postgresql://postgres:pw@shortline.proxy.rlwy.net:41234/railway?sslmode=require", 10);
    expect(new URL(proxy.connectionString!).searchParams.get("sslmode")).toBe("no-verify");
    expect(isNeonPooler(proxy.connectionString!)).toBe(false);
  });

  it("requires the direct Neon endpoint when DATABASE_URL is the pooler", () => {
    const pooled = "postgresql://u:p@ep-cool-name-a1b2c3-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";
    expect(() => loadConfig({ ...base, DATABASE_URL: pooled } as NodeJS.ProcessEnv)).toThrow(/DATABASE_DIRECT_URL/);
    const direct = pooled.replace("-pooler", "");
    const c = loadConfig({ ...base, DATABASE_URL: pooled, DATABASE_DIRECT_URL: direct } as NodeJS.ProcessEnv);
    expect(c.DATABASE_DIRECT_URL).toBe(direct);
    expect(() => loadConfig({ ...base, DATABASE_URL: pooled, DATABASE_DIRECT_URL: pooled } as NodeJS.ProcessEnv)).toThrow(/without '-pooler'/);
  });

  it("maps Neon's sslmode/channel_binding to verified TLS + SCRAM channel binding", () => {
    const cfg = poolConfig("postgresql://u:p@ep-x-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require", 10);
    const url = new URL(cfg.connectionString!);
    expect(url.searchParams.get("sslmode")).toBe("verify-full");
    expect(url.searchParams.has("channel_binding")).toBe(false);
    expect(cfg.enableChannelBinding).toBe(true);
    expect(cfg.keepAlive).toBe(true);
    expect(cfg.connectionTimeoutMillis).toBe(15_000);
    expect(isNeonPooler(cfg.connectionString!)).toBe(true);
    expect(poolConfig("postgres://gamebot:gamebot@localhost:54340/gamebot", 5).enableChannelBinding).toBeUndefined();
  });
});
