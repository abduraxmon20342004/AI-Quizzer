import type { AiProvider } from "../ai/provider.js";
import type { AiPricing } from "../ai/budget.js";
import type { Clock } from "../clock.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/db.js";
import type { JobQueue } from "../jobs/queue.js";
import type { Logger } from "../logger.js";
import type { CallbackCodec } from "../telegram/callbackData.js";
import type { TelegramPort } from "../telegram/port.js";

/** Everything a service needs, passed explicitly (no globals) so tests and the simulator can swap parts. */
export interface AppContext {
  cfg: AppConfig;
  db: Db;
  clock: Clock;
  log: Logger;
  tg: TelegramPort;
  ai: AiProvider;
  pricing: AiPricing;
  jobs: JobQueue;
  callbacks: CallbackCodec;
  bot: { id: number; username: string };
  metrics: Metrics;
}

/** Minimal in-process counters exposed on /metrics. */
export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }
  set(name: string, value: number): void {
    this.gauges.set(name, value);
  }
  render(): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`# TYPE ${k} counter`, `${k} ${v}`);
    for (const [k, v] of this.gauges) lines.push(`# TYPE ${k} gauge`, `${k} ${v}`);
    return lines.join("\n") + "\n";
  }
}

export function isBotAdmin(ctx: Pick<AppContext, "cfg">, telegramUserId: number | undefined): boolean {
  return telegramUserId !== undefined && ctx.cfg.BOT_ADMIN_IDS.includes(telegramUserId);
}
