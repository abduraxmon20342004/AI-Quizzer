import { sql } from "kysely";
import type { Executor } from "../db/db.js";

/**
 * Cost estimation (USD per 1M tokens, provider list prices as of 2026-10). Override with
 * AI_PRICING_JSON='{"model-id":{"input":1,"output":5}}'. Unknown models are priced conservatively.
 */
const DEFAULT_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI standard tier (developers.openai.com, 2026-10). Prompts over 272K input tokens cost more; ours stay far below.
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  mock: { input: 0, output: 0 },
};
const UNKNOWN_PRICE = { input: 10, output: 50 };

export class AiPricing {
  private readonly table: Record<string, { input: number; output: number }>;
  constructor(overrideJson?: string) {
    this.table = { ...DEFAULT_PRICING, ...(overrideJson ? (JSON.parse(overrideJson) as typeof DEFAULT_PRICING) : {}) };
  }
  cost(model: string, inputTokens: number, outputTokens: number): number {
    // Responses may name a dated snapshot (e.g. gpt-6-luna-2026-09-22 / -20260922): price it as the base model.
    const p = this.table[model] ?? this.table[model.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")] ?? UNKNOWN_PRICE;
    return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  }
}

export async function spentToday(db: Executor, groupId: number, localDate: string): Promise<number> {
  const row = await db
    .selectFrom("ai_usage")
    .select(sql<number>`coalesce(sum(cost_usd), 0)`.as("total"))
    .where("group_id", "=", groupId)
    .where("local_date", "=", localDate)
    .executeTakeFirst();
  return Number(row?.total ?? 0);
}

export async function recordUsage(
  db: Executor,
  u: { groupId: number | null; purpose: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; ok: boolean; error?: string; durationMs: number; localDate: string },
): Promise<void> {
  await db
    .insertInto("ai_usage")
    .values({
      group_id: u.groupId,
      purpose: u.purpose,
      model: u.model,
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      cost_usd: u.costUsd,
      ok: u.ok,
      error: u.error ? u.error.slice(0, 500) : null,
      duration_ms: u.durationMs,
      local_date: u.localDate,
    })
    .execute();
}
