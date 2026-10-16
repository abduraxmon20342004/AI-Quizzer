import type { AppContext } from "../app/context.js";
import type { Executor } from "../db/db.js";
import { escapeHtml } from "../domain/telegramLimits.js";
import { enqueue } from "./outbox.js";

/**
 * Private alert to every bot admin (admins have started the bot, so private messages are allowed).
 * With a key, the same alert is sent only once.
 */
export async function alertAdmins(ctx: AppContext, ex: Executor, a: { key?: string; groupId: number | null; text: string }): Promise<boolean> {
  const key = a.key ?? `adhoc:${ctx.clock.now().getTime()}:${Math.random().toString(36).slice(2, 8)}`;
  const inserted = await ex
    .insertInto("admin_alerts")
    .values({ alert_key: key, group_id: a.groupId, message: a.text.slice(0, 2000) })
    .onConflict((oc) => oc.column("alert_key").doNothing())
    .returning("alert_key")
    .executeTakeFirst();
  if (!inserted) return false;
  let title = "";
  if (a.groupId) {
    const g = await ex.selectFrom("groups").select("title").where("id", "=", a.groupId).executeTakeFirst();
    if (g?.title) title = `<b>${escapeHtml(g.title)}</b>\n`;
  }
  for (const adminId of ctx.cfg.BOT_ADMIN_IDS) {
    await enqueue(ex, {
      groupId: a.groupId,
      chatId: adminId,
      method: "sendMessage",
      payload: { chat_id: adminId, text: `⚠️ ${title}${a.text}`.slice(0, 4000), parse_mode: "HTML" },
      dedupeKey: `alert:${key}:${adminId}`,
      purpose: "admin_alert",
    });
  }
  ctx.metrics.inc("admin_alerts_total");
  return true;
}
