import type { AppContext } from "../app/context.js";
import { localDateOf } from "../domain/time.js";
import { getSettings } from "../services/groups.js";
import { recordUsage, spentToday } from "./budget.js";
import { AiPermanentError, type StructuredRequest, type StructuredResult } from "./provider.js";

export class AiBudgetExceeded extends Error {
  constructor(readonly spent: number, readonly budget: number) {
    super(`daily AI budget reached (${spent.toFixed(2)} / ${budget.toFixed(2)} USD)`);
  }
}

/**
 * Run one structured AI request with: per-group daily budget check, bounded attempts with exponential
 * backoff + jitter for transient errors, and usage/cost recording. Never on the critical answer path.
 */
export async function runAi<T>(ctx: AppContext, groupId: number | null, purpose: string, req: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const now = ctx.clock.now();
  let localDate = localDateOf(now, ctx.cfg.DEFAULT_TIMEZONE);
  if (groupId) {
    const s = await getSettings(ctx, ctx.db, groupId);
    localDate = localDateOf(now, s.timezone);
    const spent = await spentToday(ctx.db, groupId, localDate);
    if (spent >= s.aiDailyBudgetUsd) throw new AiBudgetExceeded(spent, s.aiDailyBudgetUsd);
  }
  let lastErr: unknown;
  for (let attempt = 1; attempt <= ctx.cfg.AI_MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      const res = await ctx.ai.structured(req);
      const cost = ctx.pricing.cost(res.model, res.inputTokens, res.outputTokens);
      await recordUsage(ctx.db, { groupId, purpose, model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, costUsd: cost, ok: true, durationMs: Date.now() - started, localDate });
      ctx.metrics.inc(`ai_requests_total{purpose="${purpose}",ok="true"}`);
      ctx.metrics.inc("ai_cost_usd_micros_total", Math.round(cost * 1_000_000));
      return res;
    } catch (err) {
      lastErr = err;
      await recordUsage(ctx.db, { groupId, purpose, model: req.model, inputTokens: 0, outputTokens: 0, costUsd: 0, ok: false, error: (err as Error).message, durationMs: Date.now() - started, localDate });
      ctx.metrics.inc(`ai_requests_total{purpose="${purpose}",ok="false"}`);
      if (err instanceof AiPermanentError || attempt === ctx.cfg.AI_MAX_ATTEMPTS) throw err;
      const delay = Math.min(30_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
      ctx.log.warn({ purpose, attempt, delay, err: (err as Error).message }, "AI request failed, retrying");
      await new Promise((r) => setTimeout(r, ctx.ai.isMock ? 1 : delay));
    }
  }
  throw lastErr;
}
