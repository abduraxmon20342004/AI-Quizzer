import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../../src/app/http.js";
import { createRouter } from "../../src/bot/router.js";
import { createLogger } from "../../src/logger.js";
import { PgBossQueue } from "../../src/jobs/queue.js";
import { closeSharedDb } from "../../src/sim/harness.js";
import { newHarness } from "./setup.js";

afterAll(closeSharedDb);

describe("PostgreSQL job queue (pg-boss)", () => {
  it("enqueues inside a transaction (rolled back -> no job), runs workers, and dead-letters exhausted jobs", async () => {
    const queue = new PgBossQueue(process.env.TEST_DATABASE_URL!, createLogger("silent", false));
    await queue.start();
    const h = await newHarness();
    const seen: number[] = [];
    const dead: string[] = [];
    try {
      await h.ctx.db
        .transaction()
        .execute(async (tx) => {
          await queue.send("material.extract", { materialId: 111 }, {}, tx);
          throw new Error("rollback");
        })
        .catch(() => {});
      await h.ctx.db.transaction().execute((tx) => queue.send("material.extract", { materialId: 222 }, {}, tx));
      await queue.boss.updateQueue("answers.grade", { retryLimit: 0 } as never);
      await queue.send("answers.grade", { submissionId: 999 });
      await queue.work(
        {
          "material.extract": async (d) => void seen.push(d.materialId),
          "questions.generate": async () => {},
          "questions.review": async () => {},
          "answers.grade": async () => {
            throw new Error("always fails");
          },
          "asset.review": async () => {},
          "bank.prepare": async () => {},
        },
        {},
        async (job) => void dead.push(JSON.stringify(job.data)),
      );
      const deadline = Date.now() + 20_000;
      while ((seen.length < 1 || dead.length < 1) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
      expect(seen).toEqual([222]);
      expect(dead.some((d) => d.includes("999"))).toBe(true);
    } finally {
      await queue.stop();
    }
  }, 60_000);
});

describe("HTTP server", () => {
  it("serves health and metrics, and accepts webhook updates only with the secret token", async () => {
    const h = await newHarness();
    const router = createRouter(h.ctx);
    let handled = 0;
    const server = createHttpServer(h.ctx, {
      webhook: { path: "/telegram/webhook", secret: "s3cret_token_for_tests", handle: async (u) => { handled++; await router.handleUpdate(u); } },
      workerExpected: false,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const health = await fetch(`${base}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ ok: true, db: "ok" });
      const metrics = await (await fetch(`${base}/metrics`)).text();
      expect(metrics).toContain("outbox_rows");
      const update = JSON.stringify({ update_id: 1, message: { message_id: 1, date: 0, chat: { id: 5, type: "private" }, from: { id: 5, is_bot: false, first_name: "A" }, text: "salom" } });
      const bad = await fetch(`${base}/telegram/webhook`, { method: "POST", body: update, headers: { "x-telegram-bot-api-secret-token": "wrong" } });
      expect(bad.status).toBe(401);
      const good = await fetch(`${base}/telegram/webhook`, { method: "POST", body: update, headers: { "x-telegram-bot-api-secret-token": "s3cret_token_for_tests" } });
      expect(good.status).toBe(200);
      expect(handled).toBe(1);
    } finally {
      await new Promise((r) => server.close(() => r(null)));
    }
  });
});
