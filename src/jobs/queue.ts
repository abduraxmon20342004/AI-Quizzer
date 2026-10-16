import { fromKysely, PgBoss } from "pg-boss";
import { Transaction } from "kysely";
import { poolConfig, type Executor } from "../db/db.js";
import type { Logger } from "../logger.js";

/** Background job names. Each has its own queue and bounded concurrency. */
export type JobName = "material.extract" | "questions.generate" | "questions.review" | "answers.grade" | "asset.review" | "bank.prepare";

export interface JobData {
  "material.extract": { materialId: number };
  "questions.generate": { batchId: number; retryVersionIds?: number[] };
  "questions.review": { batchId: number; versionIds: number[] };
  "answers.grade": { submissionId: number };
  "asset.review": { assetId: number };
  "bank.prepare": { groupId?: number };
}

export interface SendOpts {
  /** Deduplicate: only one queued job per key. */
  singletonKey?: string;
  startAfterSeconds?: number;
}

export interface JobQueue {
  send<N extends JobName>(name: N, data: JobData[N], opts?: SendOpts, ex?: Executor): Promise<void>;
}

export type JobHandlers = { [N in JobName]: (data: JobData[N]) => Promise<void> };

export const DEAD_LETTER_QUEUE = "dead-letter";

/**
 * Durable PostgreSQL-backed queue (pg-boss 12). Retries use exponential backoff with jitter
 * (retryBackoff + retryDelayMax), jobs that exhaust retries move to a dead-letter queue whose worker alerts
 * the admin. When called with a Kysely transaction the job is inserted in that same transaction.
 */
export class PgBossQueue implements JobQueue {
  readonly boss: PgBoss;
  constructor(connectionString: string, private readonly log: Logger) {
    // Same SSL handling as the app pool (Neon: verify-full); channel binding is not configurable in pg-boss.
    const pc = poolConfig(connectionString, 4);
    this.boss = new PgBoss({ connectionString: pc.connectionString!, schema: "pgboss", max: 4, connectionTimeoutMillis: pc.connectionTimeoutMillis ?? 5000 });
    this.boss.on("error", (err: Error) => this.log.error({ err: err.message }, "pg-boss error"));
  }

  async start(): Promise<void> {
    await this.boss.start();
    await this.ensureQueue(DEAD_LETTER_QUEUE, { retryLimit: 0 });
    const common = { retryBackoff: true, retryDelay: 5, retryDelayMax: 300, deadLetter: DEAD_LETTER_QUEUE };
    await this.ensureQueue("material.extract", { ...common, retryLimit: 2, expireInSeconds: 600 });
    await this.ensureQueue("questions.generate", { ...common, retryLimit: 2, expireInSeconds: 1800 });
    await this.ensureQueue("questions.review", { ...common, retryLimit: 2, expireInSeconds: 1800 });
    await this.ensureQueue("answers.grade", { ...common, retryLimit: 3, expireInSeconds: 600 });
    await this.ensureQueue("asset.review", { ...common, retryLimit: 2, expireInSeconds: 600 });
    await this.ensureQueue("bank.prepare", { ...common, retryLimit: 1, expireInSeconds: 600, policy: "short" });
  }

  private async ensureQueue(name: string, options: Record<string, unknown>): Promise<void> {
    const existing = await this.boss.getQueue(name);
    if (!existing) await this.boss.createQueue(name, options as never);
    else {
      const { policy: _ignored, ...updatable } = options;
      await this.boss.updateQueue(name, updatable as never);
    }
  }

  async send<N extends JobName>(name: N, data: JobData[N], opts: SendOpts = {}, ex?: Executor): Promise<void> {
    const options: Record<string, unknown> = {};
    if (opts.singletonKey) options.singletonKey = opts.singletonKey;
    if (opts.startAfterSeconds) options.startAfter = opts.startAfterSeconds;
    if (ex && ex instanceof Transaction) options.db = fromKysely(ex as never);
    await this.boss.send(name, data as object, options as never);
  }

  async work(handlers: JobHandlers, concurrency: Partial<Record<JobName, number>>, onDeadLetter: (job: { name: string; data: unknown }) => Promise<void>): Promise<void> {
    for (const name of Object.keys(handlers) as JobName[]) {
      const handler = handlers[name] as (d: unknown) => Promise<void>;
      await this.boss.work(name, { localConcurrency: concurrency[name] ?? 1, pollingIntervalSeconds: 1 }, async ([job]) => {
        if (!job) return;
        const started = Date.now();
        try {
          await handler(job.data);
          this.log.debug({ job: name, id: job.id, ms: Date.now() - started }, "job done");
        } catch (err) {
          this.log.warn({ job: name, id: job.id, err: (err as Error).message }, "job failed (will retry or dead-letter)");
          throw err;
        }
      });
    }
    await this.boss.work(DEAD_LETTER_QUEUE, async ([job]) => {
      if (job) await onDeadLetter({ name: String((job as { name?: string }).name ?? "unknown"), data: job.data });
    });
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 20_000 });
  }
}

/**
 * In-process queue for tests, the simulator and the load test. Jobs are collected and run by drain(),
 * which makes "background" work deterministic in tests.
 */
export class InlineQueue implements JobQueue {
  readonly pending: { name: JobName; data: unknown; key?: string }[] = [];
  handlers: Partial<JobHandlers> = {};
  failures: { name: JobName; error: string }[] = [];

  async send<N extends JobName>(name: N, data: JobData[N], opts: SendOpts = {}): Promise<void> {
    if (opts.singletonKey && this.pending.some((p) => p.key === opts.singletonKey)) return;
    this.pending.push({ name, data, ...(opts.singletonKey ? { key: opts.singletonKey } : {}) });
  }

  /** Run queued jobs (including jobs queued while draining) until empty or `max` jobs ran. */
  async drain(max = 1000): Promise<number> {
    let ran = 0;
    while (this.pending.length && ran < max) {
      const job = this.pending.shift()!;
      const h = this.handlers[job.name] as ((d: unknown) => Promise<void>) | undefined;
      if (!h) throw new Error(`no handler for job ${job.name}`);
      try {
        await h(job.data);
      } catch (err) {
        this.failures.push({ name: job.name, error: (err as Error).message });
      }
      ran++;
    }
    return ran;
  }
}
