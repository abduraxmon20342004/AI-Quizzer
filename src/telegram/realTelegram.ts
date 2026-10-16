import { Api } from "node-telegram-bot-api";
import type { TelegramPort } from "./port.js";

/**
 * Real Bot API adapter. Automatic retries are DISABLED (maxRetries: 0): a send that timed out may already
 * have been accepted by Telegram, so retrying blindly could post a question twice. The outbox decides.
 * answerCallbackQuery uses a separate client with a short timeout and one retry (repeating it is harmless).
 */
export function createRealTelegram(token: string, opts: { sendTimeoutMs: number; apiRoot?: string }): { port: TelegramPort; pollingApi: Api } {
  const base = opts.apiRoot ? { apiRoot: opts.apiRoot } : {};
  const api = new Api(token, { ...base, maxRetries: 0, timeoutMs: opts.sendTimeoutMs, maxRetryAfterMs: 1 });
  const fastApi = new Api(token, { ...base, maxRetries: 1, timeoutMs: 5000, maxRetryAfterMs: 2000 });
  const pollingApi = new Api(token, { ...base, maxRetries: 2 });
  const apiRoot = opts.apiRoot ?? "https://api.telegram.org";

  const port: TelegramPort = {
    getMe: () => fastApi.getMe(),
    sendMessage: (p) => api.sendMessage(p),
    sendPoll: (p) => api.sendPoll(p),
    sendPhoto: (p) => api.sendPhoto(p),
    stopPoll: (p) => api.stopPoll(p),
    editMessageText: (p) => api.editMessageText(p),
    editMessageReplyMarkup: (p) => api.editMessageReplyMarkup(p),
    answerCallbackQuery: (p) => fastApi.answerCallbackQuery(p),
    getChatMember: (p) => fastApi.getChatMember(p),
    getChatMemberCount: (p) => fastApi.getChatMemberCount(p),
    getFile: (p) => fastApi.getFile(p),
    async downloadFile(filePath, maxBytes) {
      const res = await fetch(`${apiRoot}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok || !res.body) throw new Error(`file download failed: HTTP ${res.status}`);
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > maxBytes) throw new Error(`file too large (${declared} bytes)`);
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        total += chunk.byteLength;
        if (total > maxBytes) throw new Error(`file too large (> ${maxBytes} bytes)`);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
  };
  return { port, pollingApi };
}
