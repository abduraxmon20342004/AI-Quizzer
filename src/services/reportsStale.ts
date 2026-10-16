import type { Executor } from "../db/db.js";
import { weekStartOf } from "../domain/time.js";

/** Flag the daily (and weekly) report covering localDate for re-rendering; the worker edits the messages. */
export async function markReportsStale(ex: Executor, groupId: number, localDate: string): Promise<void> {
  await ex
    .updateTable("reports")
    .set({ needs_refresh: true })
    .where("group_id", "=", groupId)
    .where((eb) =>
      eb.or([
        eb.and([eb("kind", "=", "daily"), eb("period_key", "=", localDate)]),
        eb.and([eb("kind", "=", "weekly"), eb("period_key", "=", weekStartOf(localDate))]),
      ]),
    )
    .where("needs_refresh", "=", false)
    .execute();
}
