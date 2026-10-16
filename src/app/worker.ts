import { sql } from "kysely";
import type { AppContext } from "./context.js";
import type { JobHandlers } from "../jobs/queue.js";
import { alertAdmins } from "../services/alerts.js";
import { handleBankPrepare, handleGenerate, handleReview } from "../services/generation.js";
import { handleGrade } from "../services/grading.js";
import { handleAssetReview, handleExtract, purgeRawFiles } from "../services/materials.js";
import { dispatchOutbox, recoverStaleSending } from "../services/outbox.js";
import { ensurePlans } from "../services/planner.js";
import { refreshReports, runDayEnds, runWeeklyReports } from "../services/reports.js";
import { closeDue, publishDue, sendDueClues } from "../services/runner.js";

export function jobHandlers(ctx: AppContext): JobHandlers {
  return {
    "material.extract": (d) => handleExtract(ctx, d),
    "questions.generate": (d) => handleGenerate(ctx, d),
    "questions.review": (d) => handleReview(ctx, d),
    "answers.grade": (d) => handleGrade(ctx, d),
    "asset.review": (d) => handleAssetReview(ctx, d),
    "bank.prepare": (d) => handleBankPrepare(ctx, d),
  };
}

export async function onDeadLetter(ctx: AppContext, job: { name: string; data: unknown }): Promise<void> {
  ctx.metrics.inc("jobs_dead_letter_total");
  const data = (job.data ?? {}) as Record<string, unknown>;
  // A grading job that died must not leave an answer silently pending: send it to admin review.
  if (typeof data.submissionId === "number") {
    const { applyVerdict } = await import("../services/grading.js");
    const sub = await ctx.db.selectFrom("submissions").select(["verdict"]).where("id", "=", data.submissionId).executeTakeFirst();
    if (sub?.verdict === "pending") {
      await ctx.db.transaction().execute((tx) => applyVerdict(ctx, tx, { submissionId: data.submissionId as number, verdict: "needs_review", method: "system", reason: "grading job failed repeatedly" }));
    }
  }
  await alertAdmins(ctx, ctx.db, { key: `dlq:${JSON.stringify(data).slice(0, 80)}:${job.name}`, groupId: null, text: `Fon vazifasi bir necha urinishdan keyin bajarilmadi (${job.name}). Tafsilotlar loglarda.` });
}

type Step = { name: string; everyMs: number; run: () => Promise<unknown>; last: number };

/**
 * One scheduler pass. Every step works purely from database state, so a pass after a crash or restart
 * recovers: overdue open questions close with their original deadlines, stale unpublished slots are skipped
 * (admin alerted), and a missing report is produced exactly once.
 */
export function createScheduler(ctx: AppContext, opts: { bankPrepare: boolean } = { bankPrepare: true }) {
  const steps: Step[] = [
    { name: "recover", everyMs: 30_000, run: () => recoverStaleSending(ctx), last: 0 },
    { name: "plans", everyMs: 60_000, run: () => ensurePlans(ctx), last: 0 },
    { name: "publish", everyMs: 0, run: () => publishDue(ctx), last: 0 },
    { name: "clues", everyMs: 0, run: () => sendDueClues(ctx), last: 0 },
    { name: "close", everyMs: 0, run: () => closeDue(ctx), last: 0 },
    { name: "dispatch", everyMs: 0, run: () => dispatchOutbox(ctx, 50), last: 0 },
    { name: "dayEnds", everyMs: 0, run: () => runDayEnds(ctx), last: 0 },
    { name: "weekly", everyMs: 30_000, run: () => runWeeklyReports(ctx), last: 0 },
    { name: "refresh", everyMs: 5_000, run: () => refreshReports(ctx), last: 0 },
    { name: "dispatch2", everyMs: 0, run: () => dispatchOutbox(ctx, 50), last: 0 },
    ...(opts.bankPrepare ? [{ name: "bank", everyMs: 10 * 60_000, run: () => ctx.jobs.send("bank.prepare", {}, { singletonKey: "bank" }), last: 0 }] : []),
    { name: "retention", everyMs: 6 * 3600_000, run: () => purgeRawFiles(ctx), last: 0 },
    {
      name: "heartbeat",
      everyMs: 5_000,
      run: () =>
        ctx.db
          .insertInto("worker_heartbeats")
          .values({ worker: "scheduler", beat_at: ctx.clock.now(), info: JSON.stringify({ pid: process.pid }) })
          .onConflict((oc) => oc.column("worker").doUpdateSet({ beat_at: ctx.clock.now() }))
          .execute(),
      last: 0,
    },
  ];
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  async function tick(force = false): Promise<void> {
    const now = ctx.clock.now().getTime();
    for (const s of steps) {
      if (!force && s.everyMs && now - s.last < s.everyMs) continue;
      s.last = now;
      try {
        await s.run();
      } catch (err) {
        ctx.metrics.inc(`scheduler_errors_total{step="${s.name}"}`);
        ctx.log.error({ step: s.name, err: (err as Error).message }, "scheduler step failed");
      }
    }
    // Queue delay metric: age of the oldest due outbox row.
    const oldest = await ctx.db
      .selectFrom("outbox")
      .select(sql<Date | null>`min(next_attempt_at)`.as("t"))
      .where("status", "=", "pending")
      .executeTakeFirst()
      .catch(() => undefined);
    ctx.metrics.set("outbox_oldest_pending_ms", oldest?.t ? Math.max(0, ctx.clock.now().getTime() - new Date(oldest.t).getTime()) : 0);
  }

  return {
    tick,
    start(intervalMs: number) {
      const loop = async () => {
        if (stopped) return;
        running = tick();
        await running;
        running = null;
        if (!stopped) timer = setTimeout(loop, intervalMs);
      };
      void loop();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (running) await running;
    },
  };
}
