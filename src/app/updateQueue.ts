import type { Update } from "node-telegram-bot-api";

/**
 * Processes a batch of updates concurrently while keeping updates from the same user (or chat) strictly in
 * order - e.g. one student's guesses are processed in the order they arrived.
 */
export function updateKey(u: Update): string {
  const x = u as Record<string, unknown> & Update;
  const from =
    (x.callback_query as { from?: { id: number } } | undefined)?.from?.id ??
    (x.poll_answer as { user?: { id: number } } | undefined)?.user?.id ??
    (x.message as { from?: { id: number }; chat?: { id: number } } | undefined)?.from?.id ??
    (x.chat_member as { chat?: { id: number } } | undefined)?.chat?.id ??
    (x.my_chat_member as { chat?: { id: number } } | undefined)?.chat?.id;
  return from !== undefined ? String(from) : `u${u.update_id}`;
}

export async function processBatch(updates: Update[], handle: (u: Update) => Promise<void>, concurrency = 4, onError?: (u: Update, e: unknown) => void): Promise<void> {
  const groups = new Map<string, Update[]>();
  for (const u of updates) {
    const k = updateKey(u);
    const list = groups.get(k) ?? [];
    list.push(u);
    groups.set(k, list);
  }
  const lanes = [...groups.values()];
  let next = 0;
  const worker = async () => {
    while (next < lanes.length) {
      const lane = lanes[next++]!;
      for (const u of lane) {
        try {
          await handle(u);
        } catch (err) {
          onError?.(u, err);
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, lanes.length) }, worker));
}
