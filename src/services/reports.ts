import { sql } from "kysely";
import type { AppContext } from "../app/context.js";
import type { Executor, Tx } from "../db/db.js";
import type { Row } from "../db/schema.js";
import type { GameType } from "../domain/gameTypes.js";
import { renderDailyReport, renderWeeklyReport, type ReportRow } from "../domain/reportFormat.js";
import { weeklyReportDueAt } from "../domain/schedule.js";
import { sha256 } from "../domain/similarity.js";
import { addDays, localDateOf, weekDates, weekStartOf } from "../domain/time.js";
import type { Lang } from "../i18n/index.js";
import { getSettings, listActiveGroups } from "./groups.js";
import { enqueue, registerOutboxHandler } from "./outbox.js";
import { applyStreakBonuses, computeDayParticipation } from "./participation.js";
import { listStudents } from "./roster.js";
import { periodStats } from "./stats.js";

/**
 * Daily and weekly reports. One logical report per group/day (UNIQUE group_id, kind, period_key): it can be
 * split into numbered parts, and later corrections EDIT the stored messages instead of posting a new report.
 */

interface Built {
  parts: string[];
  hasPending: boolean;
  winnerIds?: number[];
  rows?: ReportRow[];
}

async function buildRows(ctx: AppContext, ex: Executor, groupId: number, planIds: number[], dates: string[], period: "day" | "week", periodKey: string, showInactive: boolean) {
  const stats = await periodStats(ex, groupId, planIds);
  const students = await listStudents(ex, groupId, { includeArchived: true });
  const totals = await ex
    .selectFrom("score_totals")
    .select(["student_id", "points"])
    .where("group_id", "=", groupId)
    .where("period", "=", period)
    .where("period_key", "=", periodKey)
    .execute();
  const pointsBy = new Map(totals.map((t) => [t.student_id, t.points]));
  const bonusRows = dates.length
    ? await ex
        .selectFrom("score_ledger")
        .select(["student_id", sql<number>`sum(points)::int`.as("bonus")])
        .where("group_id", "=", groupId)
        .where("local_date", "in", dates)
        .where((eb) => eb.or([eb("kind", "=", "streak_bonus"), eb("award_key", "like", "streak-revoke:%")]))
        .groupBy("student_id")
        .execute()
    : [];
  const bonusBy = new Map(bonusRows.map((b) => [b.student_id, b.bonus]));
  const main: ReportRow[] = [];
  const inactive: ReportRow[] = [];
  for (const s of students) {
    const st = stats.get(s.id);
    const row: ReportRow = {
      studentId: s.id,
      name: s.name,
      points: pointsBy.get(s.id) ?? 0,
      correct: st?.correct ?? 0,
      wrong: st?.wrong ?? 0,
      pending: st?.pending ?? 0,
      unanswered: st ? Math.max(0, st.opportunities - st.answered) : 0,
      bonus: Math.max(0, bonusBy.get(s.id) ?? 0),
    };
    const eligibleNow = s.status === "eligible" && s.membership === "member";
    if (eligibleNow) main.push(row);
    else if (showInactive && st && st.answered > 0) inactive.push(row);
  }
  return { main, inactive };
}

async function buildDaily(ctx: AppContext, ex: Executor, plan: Row<"day_plans">): Promise<Built> {
  const s = await getSettings(ctx, ex, plan.group_id);
  const { main, inactive } = await buildRows(ctx, ex, plan.group_id, [plan.id], [plan.local_date], "day", plan.local_date, s.showInactiveSection);
  const parts = renderDailyReport({
    lang: s.language as Lang,
    localDate: plan.local_date,
    topic: s.topic,
    gameType: plan.game_type as GameType | null,
    rows: main,
    inactive,
    canceled: !!plan.canceled_at,
  });
  return { parts, hasPending: [...main, ...inactive].some((r) => r.pending > 0) };
}

async function buildWeekly(ctx: AppContext, ex: Executor, groupId: number, weekStart: string): Promise<Built> {
  const s = await getSettings(ctx, ex, groupId);
  const dates = weekDates(weekStart);
  const plans = await ex.selectFrom("day_plans").select("id").where("group_id", "=", groupId).where("local_date", "in", dates).execute();
  const { main, inactive } = await buildRows(ctx, ex, groupId, plans.map((p) => p.id), dates, "week", weekStart, s.showInactiveSection);
  const r = renderWeeklyReport({ lang: s.language as Lang, weekStart, weekEnd: dates[6]!, rows: main, inactive });
  return { parts: r.parts, hasPending: r.provisional, winnerIds: r.winnerIds, rows: main };
}

async function publishParts(ex: Tx, report: Row<"reports">, chatId: number, parts: string[]): Promise<void> {
  for (const [i, text] of parts.entries()) {
    const part = i + 1;
    await ex.insertInto("report_messages").values({ report_id: report.id, part, chat_id: chatId, text_hash: sha256(text) }).onConflict((oc) => oc.columns(["report_id", "part"]).doNothing()).execute();
    await enqueue(ex, {
      groupId: report.group_id,
      chatId,
      method: "sendMessage",
      payload: { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } },
      dedupeKey: `report:${report.id}:${part}:send`,
      purpose: "report_part",
      refId: report.id,
      refPart: part,
    });
  }
}

/** Creates the single daily report (no-op if it already exists). */
export async function publishDailyReport(ctx: AppContext, tx: Tx, plan: Row<"day_plans">): Promise<Row<"reports"> | null> {
  const built = await buildDaily(ctx, tx, plan);
  const report = await tx
    .insertInto("reports")
    .values({ group_id: plan.group_id, kind: "daily", period_key: plan.local_date, parts: built.parts, has_pending: built.hasPending, content_hash: sha256(built.parts.join("\u0000")), published_at: ctx.clock.now() })
    .onConflict((oc) => oc.columns(["group_id", "kind", "period_key"]).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (!report) return null; // already published: never a second daily report
  const g = await tx.selectFrom("groups").select("chat_id").where("id", "=", plan.group_id).executeTakeFirstOrThrow();
  await publishParts(tx, report, g.chat_id, built.parts);
  ctx.metrics.inc("reports_published_total");
  return report;
}

/**
 * Day end: close remaining work, wait (bounded) for pending grading, then compute participation, streak
 * bonuses and publish the report. Pending results are clearly marked and the report is edited later.
 */
export async function runDayEnds(ctx: AppContext): Promise<void> {
  const now = ctx.clock.now();
  const due = await ctx.db
    .selectFrom("day_plans")
    .select("id")
    .where("status", "in", ["planned", "active"])
    .where((eb) => eb.or([eb("report_due_at", "<=", now), eb("finish_requested_at", "is not", null)]))
    .execute();
  for (const d of due) {
    await ctx.db.transaction().execute(async (tx) => {
      const plan = await tx.selectFrom("day_plans").selectAll().where("id", "=", d.id).forUpdate().skipLocked().executeTakeFirst();
      if (!plan || !["planned", "active"].includes(plan.status)) return;
      await tx
        .updateTable("question_instances")
        .set({ state: "canceled", state_reason: plan.finish_requested_at ? "finished early by admin" : "day ended", updated_at: now })
        .where("day_plan_id", "=", plan.id)
        .where("state", "=", "scheduled")
        .execute();
      if (plan.finish_requested_at) {
        // Finish and Report: the open question closes now; answers received so far count.
        await tx.updateTable("question_instances").set({ close_at: now, updated_at: now }).where("day_plan_id", "=", plan.id).where("state", "in", ["open", "uncertain", "publishing"]).where("close_at", ">", now).execute();
      }
      await tx.updateTable("day_plans").set({ status: "finishing", updated_at: now }).where("id", "=", plan.id).execute();
    });
  }

  const finishing = await ctx.db.selectFrom("day_plans").selectAll().where("status", "=", "finishing").execute();
  for (const plan of finishing) {
    const active = await ctx.db.selectFrom("question_instances").select("id").where("day_plan_id", "=", plan.id).where("state", "in", ["publishing", "open", "closing", "uncertain"]).executeTakeFirst();
    if (active) continue;
    const pending = await ctx.db
      .selectFrom("submissions as s")
      .innerJoin("question_instances as qi", "qi.id", "s.instance_id")
      .select("s.id")
      .where("qi.day_plan_id", "=", plan.id)
      .where("s.verdict", "=", "pending")
      .executeTakeFirst();
    const waitFrom = plan.finish_requested_at ?? plan.report_due_at ?? now;
    if (pending && now.getTime() < waitFrom.getTime() + ctx.cfg.REPORT_GRADING_WAIT_SECONDS * 1000) continue;
    await ctx.db.transaction().execute(async (tx) => {
      const locked = await tx.selectFrom("day_plans").selectAll().where("id", "=", plan.id).forUpdate().skipLocked().executeTakeFirst();
      if (!locked || locked.status !== "finishing") return;
      // A question counts as attempted once it was handed to Telegram (even if delivery stayed uncertain).
      const published = await tx.selectFrom("question_instances").select("id").where("day_plan_id", "=", plan.id).where("chat_id", "is not", null).executeTakeFirst();
      await computeDayParticipation(ctx, tx, plan.group_id, plan.id, plan.local_date);
      await applyStreakBonuses(ctx, tx, plan.group_id, plan.local_date);
      if (published) await publishDailyReport(ctx, tx, locked);
      await tx.updateTable("day_plans").set({ status: "finished", ended_at: ctx.clock.now(), updated_at: ctx.clock.now() }).where("id", "=", plan.id).execute();
    });
  }
}

/** Weekly report: after the week's final daily report, never while game slots of that week remain. */
export async function runWeeklyReports(ctx: AppContext): Promise<void> {
  const now = ctx.clock.now();
  for (const g of await listActiveGroups(ctx.db)) {
    const s = await getSettings(ctx, ctx.db, g.id);
    const today = localDateOf(now, s.timezone);
    for (const weekStart of [weekStartOf(addDays(today, -7)), weekStartOf(today)]) {
      if (now < weeklyReportDueAt(s, weekStart)) continue;
      const dates = weekDates(weekStart);
      const unfinished = await ctx.db
        .selectFrom("day_plans")
        .select("id")
        .where("group_id", "=", g.id)
        .where("local_date", "in", dates)
        .where("status", "in", ["planned", "active", "finishing"])
        .executeTakeFirst();
      if (unfinished) continue;
      const hadGames = await ctx.db
        .selectFrom("question_instances as qi")
        .innerJoin("day_plans as dp", "dp.id", "qi.day_plan_id")
        .select("qi.id")
        .where("dp.group_id", "=", g.id)
        .where("dp.local_date", "in", dates)
        .where("qi.chat_id", "is not", null)
        .executeTakeFirst();
      if (!hadGames) continue;
      await ctx.db.transaction().execute(async (tx) => {
        const built = await buildWeekly(ctx, tx, g.id, weekStart);
        const report = await tx
          .insertInto("reports")
          .values({
            group_id: g.id,
            kind: "weekly",
            period_key: weekStart,
            parts: built.parts,
            has_pending: built.hasPending,
            content_hash: sha256(built.parts.join("\u0000")),
            published_at: now,
            ...(built.hasPending ? {} : { status: "final" as const, finalized_at: now }),
          })
          .onConflict((oc) => oc.columns(["group_id", "kind", "period_key"]).doNothing())
          .returningAll()
          .executeTakeFirst();
        if (!report) return;
        await publishParts(tx, report, g.chat_id, built.parts);
        if (!built.hasPending) await recordChampions(ctx, tx, g.id, weekStart, built);
      });
    }
  }
}

async function recordChampions(ctx: AppContext, tx: Executor, groupId: number, weekStart: string, built: Built): Promise<void> {
  const winners = new Set(built.winnerIds ?? []);
  const current = await tx.selectFrom("champion_periods").selectAll().where("group_id", "=", groupId).where("week_start", "=", weekStart).where("status", "=", "final").execute();
  const now = ctx.clock.now();
  for (const c of current) {
    if (!winners.has(c.student_id)) {
      await tx.updateTable("champion_periods").set({ status: "revoked", decided_at: now }).where("group_id", "=", groupId).where("week_start", "=", weekStart).where("student_id", "=", c.student_id).execute();
    }
  }
  for (const row of built.rows ?? []) {
    if (!winners.has(row.studentId)) continue;
    await tx
      .insertInto("champion_periods")
      .values({ group_id: groupId, week_start: weekStart, student_id: row.studentId, points: row.points, correct: row.correct, status: "final", decided_at: now })
      .onConflict((oc) => oc.columns(["group_id", "week_start", "student_id"]).doUpdateSet({ status: "final", points: row.points, correct: row.correct, decided_at: now }))
      .execute();
  }
}

/**
 * Re-render reports flagged by corrections (late AI verdicts, admin reviews, invalidations) and edit the
 * original messages part by part. Extra parts are added as new messages of the same report.
 */
export async function refreshReports(ctx: AppContext): Promise<number> {
  const stale = await ctx.db.selectFrom("reports").selectAll().where("needs_refresh", "=", true).limit(20).execute();
  let edited = 0;
  for (const r of stale) {
    await ctx.db.transaction().execute(async (tx) => {
      const report = await tx.selectFrom("reports").selectAll().where("id", "=", r.id).forUpdate().skipLocked().executeTakeFirst();
      if (!report || !report.needs_refresh) return;
      const msgs = await tx.selectFrom("report_messages").selectAll().where("report_id", "=", report.id).orderBy("part").execute();
      if (msgs.some((m) => m.message_id === null)) return; // original parts not delivered yet; try later
      let built: Built;
      if (report.kind === "daily") {
        const plan = await tx.selectFrom("day_plans").selectAll().where("group_id", "=", report.group_id).where("local_date", "=", report.period_key).executeTakeFirstOrThrow();
        built = await buildDaily(ctx, tx, plan);
      } else {
        built = await buildWeekly(ctx, tx, report.group_id, report.period_key);
      }
      const hash = sha256(built.parts.join("\u0000"));
      const now = ctx.clock.now();
      if (hash === report.content_hash) {
        await tx.updateTable("reports").set({ needs_refresh: false }).where("id", "=", report.id).execute();
        return;
      }
      const chatId = msgs[0]?.chat_id ?? (await tx.selectFrom("groups").select("chat_id").where("id", "=", report.group_id).executeTakeFirstOrThrow()).chat_id;
      const total = Math.max(built.parts.length, msgs.length);
      for (let i = 0; i < total; i++) {
        const part = i + 1;
        const text = built.parts[i] ?? "—";
        const textHash = sha256(text);
        const existing = msgs.find((m) => m.part === part);
        if (existing) {
          if (existing.text_hash === textHash) continue;
          await enqueue(tx, {
            groupId: report.group_id,
            chatId,
            method: "editMessageText",
            payload: { chat_id: chatId, message_id: existing.message_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } },
            dedupeKey: `report:${report.id}:${part}:edit:${textHash.slice(0, 16)}:${now.getTime()}`,
            purpose: "report_edit",
            refId: report.id,
            refPart: part,
          });
          await tx.updateTable("report_messages").set({ text_hash: textHash }).where("report_id", "=", report.id).where("part", "=", part).execute();
        } else {
          await tx.insertInto("report_messages").values({ report_id: report.id, part, chat_id: chatId, text_hash: textHash }).execute();
          await enqueue(tx, {
            groupId: report.group_id,
            chatId,
            method: "sendMessage",
            payload: { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } },
            dedupeKey: `report:${report.id}:${part}:send`,
            purpose: "report_part",
            refId: report.id,
            refPart: part,
          });
        }
      }
      const finalNow = report.kind === "weekly" && !built.hasPending;
      await tx
        .updateTable("reports")
        .set({
          parts: built.parts,
          content_hash: hash,
          has_pending: built.hasPending,
          needs_refresh: false,
          last_edited_at: now,
          ...(finalNow ? { status: "final" as const, finalized_at: report.finalized_at ?? now } : {}),
        })
        .where("id", "=", report.id)
        .execute();
      if (report.kind === "weekly" && !built.hasPending) await recordChampions(ctx, tx, report.group_id, report.period_key, built);
      edited++;
    });
  }
  return edited;
}

export function registerReportHandlers(): void {
  registerOutboxHandler("report_part", {
    async onSent(_ctx, tx, row, result) {
      const messageId = (result as { message_id?: number } | undefined)?.message_id ?? null;
      await tx.updateTable("report_messages").set({ message_id: messageId }).where("report_id", "=", row.ref_id!).where("part", "=", row.ref_part!).execute();
    },
  });
}
