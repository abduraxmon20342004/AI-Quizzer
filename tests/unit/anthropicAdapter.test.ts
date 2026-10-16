import { describe, expect, it } from "vitest";
import { AnthropicProvider } from "../../src/ai/anthropicProvider.js";
import { AiPermanentError } from "../../src/ai/provider.js";
import { GradeSchema } from "../../src/ai/schemas.js";

/** Exercises the real Anthropic SDK request/response path with a fake HTTP layer (no network, no key). */
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; headers: Record<string, string>; json: Record<string, unknown> }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    calls.push({ url: String(url), headers, json: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_test" } });
  }) as typeof fetch;
  return { f, calls };
}

const message = (text: string, stop = "end_turn") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text }],
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30 },
});

const req = {
  task: "grade_answer" as const,
  model: "claude-opus-5-5",
  effort: "medium" as const,
  system: "sys",
  content: [{ type: "text" as const, text: "grade this" }],
  schema: GradeSchema,
  maxTokens: 2000,
  timeoutMs: 10_000,
  input: {},
};

describe("Anthropic adapter (real SDK, fake transport)", () => {
  it("sends a structured-output request with effort and the server-side refusal fallback, and parses the result", async () => {
    const { f, calls } = fakeFetch(message(JSON.stringify({ verdict: "correct", reason: "same word" })));
    const p = new AnthropicProvider("sk-test", { refusalFallback: true, maxRetries: 0, fetch: f });
    const res = await p.structured(req);
    expect(res.data).toEqual({ verdict: "correct", reason: "same word" });
    expect(res.inputTokens).toBe(120);
    const sent = calls[0]!;
    expect(sent.url).toMatch(/\/v1\/messages/);
    expect(sent.json.model).toBe("claude-opus-5-5");
    expect(sent.json.max_tokens).toBe(2000);
    const oc = sent.json.output_config as { effort: string; format: { type: string; schema: { properties: Record<string, unknown> } } };
    expect(oc.effort).toBe("medium");
    expect(oc.format.type).toBe("json_schema");
    expect(Object.keys(oc.format.schema.properties).sort()).toEqual(["reason", "verdict"]);
    expect(sent.json.fallbacks).toBe("default");
    expect(sent.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(sent.json).not.toHaveProperty("thinking");
  });

  it("treats refusals and truncated output as permanent (not retried) errors", async () => {
    const refusal = { ...message("", "refusal"), stop_details: { type: "refusal", category: "cyber", explanation: "x" } };
    const p1 = new AnthropicProvider("sk-test", { refusalFallback: false, maxRetries: 0, fetch: fakeFetch(refusal).f });
    await expect(p1.structured(req)).rejects.toBeInstanceOf(AiPermanentError);
    const p2 = new AnthropicProvider("sk-test", { refusalFallback: false, maxRetries: 0, fetch: fakeFetch(message('{"verdict":"corr', "max_tokens")).f });
    await expect(p2.structured(req)).rejects.toBeInstanceOf(AiPermanentError);
  });

  it("maps 400/401 to permanent errors and leaves 429/5xx retryable", async () => {
    const bad = new AnthropicProvider("sk-test", { refusalFallback: false, maxRetries: 0, fetch: fakeFetch({ type: "error", error: { type: "invalid_request_error", message: "bad" } }, 400).f });
    await expect(bad.structured(req)).rejects.toBeInstanceOf(AiPermanentError);
    const busy = new AnthropicProvider("sk-test", { refusalFallback: false, maxRetries: 0, fetch: fakeFetch({ type: "error", error: { type: "overloaded_error", message: "busy" } }, 529).f });
    const err = await busy.structured(req).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(AiPermanentError);
  });
});
