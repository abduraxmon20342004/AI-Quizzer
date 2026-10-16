import type { Executor } from "../db/db.js";

/** Append-only admin audit trail. Never contains raw student answers or secrets. */
export async function audit(ex: Executor, groupId: number | null, actorId: number | null, action: string, details: Record<string, unknown> = {}): Promise<void> {
  await ex.insertInto("audit_events").values({ group_id: groupId, actor_id: actorId, action, details: JSON.stringify(details) }).execute();
}
