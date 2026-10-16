import type { AppContext } from "../app/context.js";
import type { Executor } from "../db/db.js";
import type { Row } from "../db/schema.js";
import { validateSettings } from "../domain/schedule.js";
import { defaultSettings, GroupSettingsSchema, parseStoredSettings, type GroupSettings } from "../domain/settings.js";
import { audit } from "./audit.js";

export async function ensureGroup(ctx: AppContext, ex: Executor, chat: { id: number; title?: string }): Promise<Row<"groups">> {
  const existing = await ex.selectFrom("groups").selectAll().where("chat_id", "=", chat.id).executeTakeFirst();
  if (existing) {
    if (chat.title && chat.title !== existing.title) {
      await ex.updateTable("groups").set({ title: chat.title, updated_at: ctx.clock.now() }).where("id", "=", existing.id).execute();
      return { ...existing, title: chat.title };
    }
    return existing;
  }
  const group = await ex
    .insertInto("groups")
    .values({ chat_id: chat.id, title: chat.title ?? "" })
    .onConflict((oc) => oc.column("chat_id").doUpdateSet({ title: chat.title ?? "" }))
    .returningAll()
    .executeTakeFirstOrThrow();
  await ex
    .insertInto("group_settings")
    .values({ group_id: group.id, settings: JSON.stringify(defaultSettings(ctx.cfg.DEFAULT_TIMEZONE, ctx.cfg.DEFAULT_LANGUAGE)) })
    .onConflict((oc) => oc.column("group_id").doNothing())
    .execute();
  return group;
}

export async function getGroup(ex: Executor, groupId: number): Promise<Row<"groups">> {
  return ex.selectFrom("groups").selectAll().where("id", "=", groupId).executeTakeFirstOrThrow();
}

export async function getGroupByChat(ex: Executor, chatId: number): Promise<Row<"groups"> | undefined> {
  return ex.selectFrom("groups").selectAll().where("chat_id", "=", chatId).executeTakeFirst();
}

export async function getSettings(ctx: Pick<AppContext, "cfg">, ex: Executor, groupId: number): Promise<GroupSettings> {
  const row = await ex.selectFrom("group_settings").select("settings").where("group_id", "=", groupId).executeTakeFirst();
  return parseStoredSettings(row?.settings ?? {}, ctx.cfg.DEFAULT_TIMEZONE, ctx.cfg.DEFAULT_LANGUAGE);
}

export type SaveResult = { ok: true; settings: GroupSettings } | { ok: false; errors: string[] };

/**
 * Validate and save a complete settings object. Impossible schedules are rejected with explanations.
 * Rescheduling of unpublished questions happens in the caller's transaction via planner.reconcileGroup.
 */
export async function saveSettings(ctx: AppContext, ex: Executor, groupId: number, next: GroupSettings, actorId: number, change: string): Promise<SaveResult> {
  const parsed = GroupSettingsSchema.safeParse(next);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const errors = validateSettings(parsed.data);
  if (errors.length) return { ok: false, errors };
  await ex
    .updateTable("group_settings")
    .set((eb) => ({ settings: JSON.stringify(parsed.data), version: eb("version", "+", 1), updated_at: ctx.clock.now(), updated_by: actorId }))
    .where("group_id", "=", groupId)
    .execute();
  await audit(ex, groupId, actorId, "settings.update", { change });
  return { ok: true, settings: parsed.data };
}

export async function listActiveGroups(ex: Executor): Promise<Row<"groups">[]> {
  return ex.selectFrom("groups").selectAll().where("status", "=", "active").orderBy("id").execute();
}
