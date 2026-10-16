import { createServer, type Server } from "node:http";
import { sql } from "kysely";
import { safeEqual, type Update } from "node-telegram-bot-api";
import type { AppContext } from "./context.js";
import { outboxStats } from "../services/outbox.js";

const MAX_BODY = 1024 * 1024;

/**
 * Health (/healthz), metrics (/metrics) and - in webhook mode - the Telegram webhook endpoint, which is
 * authenticated by the X-Telegram-Bot-Api-Secret-Token header.
 */
export function createHttpServer(ctx: AppContext, opts: { webhook: null | { path: string; secret: string; handle: (u: Update) => Promise<void> }; workerExpected: boolean }): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/healthz") {
        const checks: Record<string, unknown> = {};
        let ok = true;
        try {
          await sql`select 1`.execute(ctx.db);
          checks.db = "ok";
        } catch (err) {
          ok = false;
          checks.db = (err as Error).message;
        }
        if (opts.workerExpected) {
          const hb = await ctx.db.selectFrom("worker_heartbeats").select("beat_at").where("worker", "=", "scheduler").executeTakeFirst().catch(() => undefined);
          const age = hb ? Date.now() - hb.beat_at.getTime() : null;
          checks.schedulerHeartbeatAgeMs = age;
          if (age === null || age > 60_000) ok = false;
        }
        res.writeHead(ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok, ...checks }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/metrics") {
        const stats: Record<string, number> = await outboxStats(ctx).catch(() => ({}));
        const extra = ["pending", "sending", "sent", "failed", "uncertain", "canceled"]
          .map((k) => `outbox_rows{status="${k}"} ${stats[k] ?? 0}`)
          .concat(`process_uptime_seconds ${Math.round(process.uptime())}`)
          .join("\n");
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(ctx.metrics.render() + extra + "\n");
        return;
      }
      if (opts.webhook && req.method === "POST" && url.pathname === opts.webhook.path) {
        const header = req.headers["x-telegram-bot-api-secret-token"];
        if (typeof header !== "string" || !safeEqual(header, opts.webhook.secret)) {
          res.writeHead(401).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_BODY) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk as Buffer);
        }
        let update: Update;
        try {
          update = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Update;
        } catch {
          res.writeHead(400).end();
          return;
        }
        try {
          await opts.webhook.handle(update);
        } catch (err) {
          // Handlers are idempotent; a poison update must not be redelivered forever, so we still ACK.
          ctx.log.error({ updateId: update.update_id, err: (err as Error).message }, "update handler failed");
        }
        res.writeHead(200).end();
        return;
      }
      res.writeHead(404).end();
    } catch (err) {
      ctx.log.error({ err: (err as Error).message }, "http error");
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
}
