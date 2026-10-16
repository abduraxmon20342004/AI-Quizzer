import { sql } from "kysely";
import type { AppContext } from "../app/context.js";
import type { Executor } from "../db/db.js";
import type { Row, StudentStatus } from "../db/schema.js";
import type { User } from "../telegram/port.js";
import { audit } from "./audit.js";

/**
 * Roster and eligibility.
 * - Telegram user ids are authoritative; students are never merged by display name.
 * - Every human member the bot discovers becomes eligible by default unless explicitly blocked.
 * - Bots and the configured bot admins (teachers) are never students.
 * - Eligibility changes are recorded as intervals (for fair "unanswered" counts) and as events (history).
 */

export async function upsertTelegramUser(ctx: AppContext, ex: Executor, u: User): Promise<void> {
  await ex
    .insertInto("telegram_users")
    .values({ id: u.id, first_name: u.first_name ?? "", last_name: u.last_name ?? null, username: u.username ?? null, is_bot: u.is_bot })
    .onConflict((oc) =>
      oc.column("id").doUpdateSet({
        first_name: u.first_name ?? "",
        last_name: u.last_name ?? null,
        username: u.username ?? null,
        updated_at: ctx.clock.now(),
      }),
    )
    .execute();
}

export function isEligible(s: Pick<Row<"students">, "status" | "membership">): boolean {
  return s.status === "eligible" && s.membership === "member";
}

async function openInterval(ex: Executor, s: Row<"students">, at: Date): Promise<void> {
  await ex
    .insertInto("eligibility_intervals")
    .values({ student_id: s.id, group_id: s.group_id, starts_at: at })
    .onConflict((oc) => oc.column("student_id").where("ends_at", "is", null).doNothing())
    .execute();
}

async function closeInterval(ex: Executor, studentId: number, at: Date): Promise<void> {
  await ex.updateTable("eligibility_intervals").set({ ends_at: at }).where("student_id", "=", studentId).where("ends_at", "is", null).execute();
}

async function recordEvent(ex: Executor, s: Row<"students">, event: string, eligibleAfter: boolean, at: Date, actorId: number | null, reason?: string) {
  await ex
    .insertInto("eligibility_events")
    .values({ student_id: s.id, group_id: s.group_id, event, eligible_after: eligibleAfter, actor_id: actorId, reason: reason ?? null, at })
    .execute();
}

/** Apply a status/membership change and keep intervals consistent. */
async function transition(ctx: AppContext, ex: Executor, s: Row<"students">, patch: Partial<Pick<Row<"students">, "status" | "membership">>, event: string, actorId: number | null, reason?: string): Promise<Row<"students">> {
  const now = ctx.clock.now();
  const before = isEligible(s);
  const updated = await ex
    .updateTable("students")
    .set({ ...patch, updated_at: now })
    .where("id", "=", s.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  const after = isEligible(updated);
  if (!before && after) await openInterval(ex, updated, now);
  if (before && !after) await closeInterval(ex, s.id, now);
  await recordEvent(ex, updated, event, after, now, actorId, reason);
  return updated;
}

export type DiscoverySource = "chat_member" | "new_members" | "message" | "poll_answer" | "callback" | "private_start" | "admin";
const MEMBERSHIP_EVIDENCE = new Set<DiscoverySource>(["chat_member", "new_members", "message", "private_start", "admin"]);

/**
 * Discover (or re-confirm) a human group member. Returns null for bots and bot admins.
 * A previously departed member who interacts again is marked as a member again (still subject to blocks).
 */
export async function discoverStudent(ctx: AppContext, ex: Executor, groupId: number, user: User, via: DiscoverySource): Promise<Row<"students"> | null> {
  if (user.is_bot || ctx.cfg.BOT_ADMIN_IDS.includes(user.id)) return null;
  const existing = await ex.selectFrom("students").selectAll().where("group_id", "=", groupId).where("telegram_user_id", "=", user.id).executeTakeFirst();
  // Hot path (every answer): a known member needs no write at all. Names are refreshed on membership events.
  if (existing && existing.membership === "member" && (via === "poll_answer" || via === "callback")) return existing;
  await upsertTelegramUser(ctx, ex, user);
  if (existing) {
    // Only real membership evidence brings a departed member back; a poll vote or button press alone does
    // not (departed students cannot submit new answers).
    if (existing.membership === "left" && MEMBERSHIP_EVIDENCE.has(via)) return transition(ctx, ex, existing, { membership: "member" }, "rejoined", null, via);
    return existing;
  }
  const now = ctx.clock.now();
  const inserted = await ex
    .insertInto("students")
    .values({ group_id: groupId, telegram_user_id: user.id, discovered_via: via, first_seen_at: now })
    .onConflict((oc) => oc.columns(["group_id", "telegram_user_id"]).doNothing())
    .returningAll()
    .executeTakeFirst();
  if (!inserted) {
    // Concurrent discovery of the same user: the other transaction won.
    return ex.selectFrom("students").selectAll().where("group_id", "=", groupId).where("telegram_user_id", "=", user.id).executeTakeFirstOrThrow();
  }
  await openInterval(ex, inserted, now);
  await recordEvent(ex, inserted, "discovered", true, now, null, via);
  ctx.metrics.inc("students_discovered_total");
  return inserted;
}

export async function markLeft(ctx: AppContext, ex: Executor, groupId: number, userId: number): Promise<void> {
  const s = await ex.selectFrom("students").selectAll().where("group_id", "=", groupId).where("telegram_user_id", "=", userId).executeTakeFirst();
  if (s && s.membership !== "left") await transition(ctx, ex, s, { membership: "left" }, "left", null);
}

/** Admin action: allow / block / archive. Past records are always preserved. */
export async function setStudentStatus(ctx: AppContext, ex: Executor, studentId: number, status: StudentStatus, actorId: number, reason?: string): Promise<Row<"students">> {
  const s = await ex.selectFrom("students").selectAll().where("id", "=", studentId).forUpdate().executeTakeFirstOrThrow();
  if (s.status === status) return s;
  const event = status === "eligible" ? "allowed" : status;
  const updated = await transition(ctx, ex, s, { status }, event, actorId, reason);
  await audit(ex, s.group_id, actorId, `student.${event}`, { studentId });
  return updated;
}

export async function getStudentByUser(ex: Executor, groupId: number, userId: number): Promise<Row<"students"> | undefined> {
  return ex.selectFrom("students").selectAll().where("group_id", "=", groupId).where("telegram_user_id", "=", userId).executeTakeFirst();
}

/** Was the student eligible at instant `at`? */
export async function wasEligibleAt(ex: Executor, studentId: number, at: Date): Promise<boolean> {
  const row = await ex
    .selectFrom("eligibility_intervals")
    .select("id")
    .where("student_id", "=", studentId)
    .where("starts_at", "<=", at)
    .where((eb) => eb.or([eb("ends_at", "is", null), eb("ends_at", ">", at)]))
    .executeTakeFirst();
  return !!row;
}

// ---------------------------------------------------------------- class list

export async function importRoster(ctx: AppContext, ex: Executor, groupId: number, names: string[], actorId: number): Promise<number> {
  const clean = [...new Set(names.map((n) => n.replace(/\s+/g, " ").trim()).filter((n) => n.length >= 2 && n.length <= 80))];
  if (!clean.length) return 0;
  const existing = new Set(
    (await ex.selectFrom("roster_entries").select("full_name").where("group_id", "=", groupId).where("archived", "=", false).execute()).map((r) => r.full_name.toLowerCase()),
  );
  const fresh = clean.filter((n) => !existing.has(n.toLowerCase()));
  if (fresh.length) {
    await ex.insertInto("roster_entries").values(fresh.map((full_name) => ({ group_id: groupId, full_name, created_by: actorId }))).execute();
  }
  await audit(ex, groupId, actorId, "roster.import", { added: fresh.length });
  return fresh.length;
}

/** Explicit admin link between a class-list name and a Telegram member (never automatic by name). */
export async function linkRoster(ctx: AppContext, ex: Executor, rosterId: number, studentId: number, actorId: number): Promise<void> {
  const entry = await ex.selectFrom("roster_entries").selectAll().where("id", "=", rosterId).executeTakeFirstOrThrow();
  const student = await ex.selectFrom("students").selectAll().where("id", "=", studentId).executeTakeFirstOrThrow();
  if (entry.group_id !== student.group_id) throw new Error("roster entry and student belong to different groups");
  await ex.updateTable("roster_entries").set({ student_id: null }).where("student_id", "=", studentId).execute();
  await ex.updateTable("roster_entries").set({ student_id: studentId }).where("id", "=", rosterId).execute();
  await recordEvent(ex, student, "linked", isEligible(student), ctx.clock.now(), actorId, `roster:${rosterId}`);
  await audit(ex, entry.group_id, actorId, "roster.link", { rosterId, studentId });
}

export async function unlinkRoster(ctx: AppContext, ex: Executor, rosterId: number, actorId: number): Promise<void> {
  const entry = await ex.selectFrom("roster_entries").selectAll().where("id", "=", rosterId).executeTakeFirstOrThrow();
  if (!entry.student_id) return;
  const student = await ex.selectFrom("students").selectAll().where("id", "=", entry.student_id).executeTakeFirstOrThrow();
  await ex.updateTable("roster_entries").set({ student_id: null }).where("id", "=", rosterId).execute();
  await recordEvent(ex, student, "unlinked", isEligible(student), ctx.clock.now(), actorId, `roster:${rosterId}`);
  await audit(ex, entry.group_id, actorId, "roster.unlink", { rosterId, studentId: entry.student_id });
}

export interface StudentView {
  id: number;
  telegramUserId: number;
  name: string;
  rosterName: string | null;
  telegramName: string;
  username: string | null;
  status: StudentStatus;
  membership: "member" | "left";
  privateReady: boolean;
}

/** Batched student listing with display names (roster name preferred over Telegram name). */
export async function listStudents(ex: Executor, groupId: number, opts: { offset?: number; limit?: number; includeArchived?: boolean } = {}): Promise<StudentView[]> {
  let q = ex
    .selectFrom("students as s")
    .innerJoin("telegram_users as u", "u.id", "s.telegram_user_id")
    .leftJoin("roster_entries as r", (j) => j.onRef("r.student_id", "=", "s.id").on("r.archived", "=", false))
    .select([
      "s.id",
      "s.telegram_user_id",
      "s.status",
      "s.membership",
      "u.first_name",
      "u.last_name",
      "u.username",
      "u.private_chat_ready",
      "r.full_name",
    ])
    .where("s.group_id", "=", groupId)
    .orderBy(sql`coalesce(r.full_name, u.first_name)`)
    .orderBy("s.id");
  if (!opts.includeArchived) q = q.where("s.status", "!=", "archived");
  if (opts.limit) q = q.limit(opts.limit).offset(opts.offset ?? 0);
  const rows = await q.execute();
  return rows.map((r) => {
    const telegramName = [r.first_name, r.last_name].filter(Boolean).join(" ") || `#${r.telegram_user_id}`;
    return {
      id: r.id,
      telegramUserId: r.telegram_user_id,
      name: r.full_name ?? telegramName,
      rosterName: r.full_name,
      telegramName,
      username: r.username,
      status: r.status,
      membership: r.membership,
      privateReady: r.private_chat_ready,
    };
  });
}

export interface RosterCompleteness {
  rosterTotal: number;
  rosterLinked: number;
  rosterUnlinked: number;
  discoveredNotInRoster: number;
  eligible: number;
  blocked: number;
  archived: number;
  left: number;
  privateReady: number;
  telegramMemberCount: number | null;
}

export async function rosterCompleteness(ex: Executor, groupId: number): Promise<RosterCompleteness> {
  const roster = await ex
    .selectFrom("roster_entries")
    .select([sql<number>`count(*)::int`.as("total"), sql<number>`count(student_id)::int`.as("linked")])
    .where("group_id", "=", groupId)
    .where("archived", "=", false)
    .executeTakeFirstOrThrow();
  const st = await ex
    .selectFrom("students as s")
    .innerJoin("telegram_users as u", "u.id", "s.telegram_user_id")
    .leftJoin("roster_entries as r", "r.student_id", "s.id")
    .select([
      sql<number>`count(*) filter (where s.status = 'eligible' and s.membership = 'member')::int`.as("eligible"),
      sql<number>`count(*) filter (where s.status = 'blocked')::int`.as("blocked"),
      sql<number>`count(*) filter (where s.status = 'archived')::int`.as("archived"),
      sql<number>`count(*) filter (where s.membership = 'left' and s.status <> 'archived')::int`.as("left"),
      sql<number>`count(*) filter (where r.id is null and s.status <> 'archived')::int`.as("unlisted"),
      sql<number>`count(*) filter (where u.private_chat_ready and s.status = 'eligible')::int`.as("ready"),
    ])
    .where("s.group_id", "=", groupId)
    .executeTakeFirstOrThrow();
  const g = await ex.selectFrom("groups").select("member_count").where("id", "=", groupId).executeTakeFirstOrThrow();
  return {
    rosterTotal: roster.total,
    rosterLinked: roster.linked,
    rosterUnlinked: roster.total - roster.linked,
    discoveredNotInRoster: st.unlisted,
    eligible: st.eligible,
    blocked: st.blocked,
    archived: st.archived,
    left: st.left,
    privateReady: st.ready,
    telegramMemberCount: g.member_count,
  };
}
