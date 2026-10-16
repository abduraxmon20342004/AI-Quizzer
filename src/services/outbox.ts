import { sql } from "kysely";
import type { AppContext } from "../app/context.js";
import type { Executor, Tx } from "../db/db.js";
import type { Row } from "../db/schema.js";
import { classifyTelegramError, type FailureClass } from "../telegram/errors.js";
import { callOutboxMethod, IDEMPOTENT_METHODS, type OutboxMethod } from "../telegram/port.js";

/**
 * Transactional outbox for every message the bot sends to groups/admins.
 *
 * Delivery guarantee (honest version): a row is handed to Telegram at most once automatically. Scoring is
 * exactly-once inside the database, but external delivery cannot be: if a send times out after Telegram may
 * have accepted it, the row becomes 'uncertain' and an admin decides (mark delivered / resend / cancel).
 * Rows that certainly did not reach Telegram (429 with retry_after, DNS/connection refused) are retried.
 */

export interface OutboxItem {
  groupId: number | null;
  chatId: number;
  method: OutboxMethod;
  payload: Record<string, unknown>;
  dedupeKey: string;
  purpose: string;
  refId?: number;
  refPart?: number;
}

export async function enqueue(ex: Executor, item: OutboxItem): Promise<number> {
  const row = await ex
    .insertInto("outbox")
    .values({
      group_id: item.groupId,
      chat_id: item.chatId,
      method: item.method,
      payload: JSON.stringify(item.payload),
      dedupe_key: item.dedupeKey,
      purpose: item.purpose,
      ref_id: item.refId ?? null,
      ref_part: item.refPart ?? null,
    })
    .onConflict((oc) => oc.column("dedupe_key").doNothing())
    .returning("id")
    .executeTakeFirst();
  if (row) return row.id;
  const existing = await ex.selectFrom("outbox").select("id").where("dedupe_key", "=", item.dedupeKey).executeTakeFirstOrThrow();
  return existing.id;
}

export interface OutboxHandler {
  onSent?(ctx: AppContext, tx: Tx, row: Row<"outbox">, result: unknown): Promise<void>;
  onFailed?(ctx: AppContext, tx: Tx, row: Row<"outbox">, failure: FailureClass): Promise<void>;
}

const handlers = new Map<string, OutboxHandler>();
export function registerOutboxHandler(purpose: string, h: OutboxHandler): void {
  handlers.set(purpose, h);
}

const LEASE_MS = 90_000;
const MAX_RETRIES = 8;

/** Claim and send due rows. Rows are processed in id order (keeps report parts and reveals in sequence). */
export async function dispatchOutbox(ctx: AppContext, limit = 20): Promise<number> {
  const now = ctx.clock.now();
  const claimed = await ctx.db.transaction().execute(async (tx) => {
    const ids = await tx
      .selectFrom("outbox")
      .select("id")
      .where("status", "=", "pending")
      .where("next_attempt_at", "<=", now)
      .orderBy("id")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
    if (!ids.length) return [];
    return tx
      .updateTable("outbox")
      .set((eb) => ({ status: "sending", lease_until: new Date(now.getTime() + LEASE_MS), attempts: eb("attempts", "+", 1) }))
      .where("id", "in", ids.map((r) => r.id))
      .returningAll()
      .execute();
  });
  claimed.sort((a, b) => a.id - b.id);
  for (const row of claimed) await sendOne(ctx, row);
  return claimed.length;
}

async function sendOne(ctx: AppContext, row: Row<"outbox">): Promise<void> {
  const started = Date.now();
  try {
    const result = await callOutboxMethod(ctx.tg, row.method as OutboxMethod, row.payload as Record<string, unknown>);
    ctx.metrics.inc("telegram_sends_total");
    ctx.metrics.set("telegram_last_send_ms", Date.now() - started);
    await markSent(ctx, row, result);
  } catch (err) {
    const failure = classifyTelegramError(err, IDEMPOTENT_METHODS.has(row.method as OutboxMethod), row.attempts);
    if (failure.kind === "noop") {
      await markSent(ctx, row, { noop: failure.reason });
      return;
    }
    ctx.metrics.inc(`telegram_send_failures_total{kind="${failure.kind}"}`);
    ctx.log.warn({ outboxId: row.id, purpose: row.purpose, method: row.method, failure: failure.kind, reason: failure.reason }, "telegram send failed");
    await ctx.db.transaction().execute(async (tx) => {
      if (failure.kind === "retry" && row.attempts < MAX_RETRIES) {
        await tx
          .updateTable("outbox")
          .set({ status: "pending", lease_until: null, last_error: failure.reason, next_attempt_at: new Date(ctx.clock.now().getTime() + failure.afterMs) })
          .where("id", "=", row.id)
          .execute();
        return;
      }
      const status = failure.kind === "uncertain" ? "uncertain" : "failed";
      await tx.updateTable("outbox").set({ status, lease_until: null, last_error: failure.reason }).where("id", "=", row.id).execute();
      await handlers.get(row.purpose)?.onFailed?.(ctx, tx, { ...row, status }, failure);
    });
  }
}

async function markSent(ctx: AppContext, row: Row<"outbox">, result: unknown): Promise<void> {
  const messageId = typeof result === "object" && result && "message_id" in result ? Number((result as { message_id: number }).message_id) : null;
  await ctx.db.transaction().execute(async (tx) => {
    const updated = await tx
      .updateTable("outbox")
      .set({ status: "sent", lease_until: null, sent_at: ctx.clock.now(), result_message_id: messageId, result: JSON.stringify(slimResult(result)) })
      .where("id", "=", row.id)
      .where("status", "in", ["sending", "uncertain"])
      .returning("id")
      .executeTakeFirst();
    if (updated) await handlers.get(row.purpose)?.onSent?.(ctx, tx, row, result);
  });
}

function slimResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return { value: result as never };
  const r = result as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if ("message_id" in r) out.message_id = r.message_id;
  if (r.poll && typeof r.poll === "object") out.poll_id = (r.poll as { id?: string }).id;
  if ("noop" in r) out.noop = r.noop;
  return out;
}

/**
 * Crash recovery: a row still 'sending' after its lease expired means the process died mid-request.
 * Idempotent methods go back to pending; non-idempotent sends become 'uncertain' (never blindly resent).
 */
export async function recoverStaleSending(ctx: AppContext): Promise<number> {
  const now = ctx.clock.now();
  const stale = await ctx.db.selectFrom("outbox").selectAll().where("status", "=", "sending").where("lease_until", "<", now).execute();
  for (const row of stale) {
    await ctx.db.transaction().execute(async (tx) => {
      if (IDEMPOTENT_METHODS.has(row.method as OutboxMethod)) {
        await tx.updateTable("outbox").set({ status: "pending", lease_until: null }).where("id", "=", row.id).where("status", "=", "sending").execute();
        return;
      }
      const res = await tx
        .updateTable("outbox")
        .set({ status: "uncertain", lease_until: null, last_error: "process stopped while sending" })
        .where("id", "=", row.id)
        .where("status", "=", "sending")
        .returning("id")
        .executeTakeFirst();
      if (res) await handlers.get(row.purpose)?.onFailed?.(ctx, tx, { ...row, status: "uncertain" }, { kind: "uncertain", reason: "process stopped while sending" });
    });
  }
  return stale.length;
}

/** Admin resolution of an uncertain send. */
export async function resolveUncertain(ctx: AppContext, outboxId: number, action: "delivered" | "resend" | "cancel", actorId: number): Promise<boolean> {
  return ctx.db.transaction().execute(async (tx) => {
    const row = await tx.selectFrom("outbox").selectAll().where("id", "=", outboxId).forUpdate().executeTakeFirst();
    if (!row || row.status !== "uncertain") return false;
    if (action === "resend") {
      await tx.updateTable("outbox").set({ status: "pending", next_attempt_at: ctx.clock.now(), last_error: `resend requested by ${actorId}` }).where("id", "=", row.id).execute();
    } else if (action === "cancel") {
      await tx.updateTable("outbox").set({ status: "canceled", last_error: `canceled by ${actorId}` }).where("id", "=", row.id).execute();
    } else {
      await tx.updateTable("outbox").set({ status: "sent", sent_at: ctx.clock.now(), last_error: `marked delivered by ${actorId}` }).where("id", "=", row.id).execute();
      await handlers.get(row.purpose)?.onSent?.(ctx, tx, row, { markedDelivered: true });
    }
    await tx.insertInto("audit_events").values({ group_id: row.group_id, actor_id: actorId, action: `outbox.${action}`, details: JSON.stringify({ outboxId }) }).execute();
    return true;
  });
}

export async function outboxStats(ctx: AppContext): Promise<Record<string, number>> {
  const rows = await ctx.db.selectFrom("outbox").select(["status", sql<number>`count(*)::int`.as("n")]).groupBy("status").execute();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
