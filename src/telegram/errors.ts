import { NetworkError, TelegramApiError, TimeoutError } from "node-telegram-bot-api";

/**
 * Classification of a failed Telegram request.
 *  - retry:     definitely not delivered (or safe to repeat) - try again later
 *  - uncertain: the request may have been accepted by Telegram (timeout / connection lost after sending);
 *               a blind resend could duplicate the message, so an admin decides
 *  - fatal:     Telegram rejected it; repeating will not help
 *  - noop:      the desired state already holds (e.g. "message is not modified", poll already closed)
 */
export type FailureClass =
  | { kind: "retry"; afterMs: number; reason: string }
  | { kind: "uncertain"; reason: string }
  | { kind: "fatal"; reason: string }
  | { kind: "noop"; reason: string };

/** Errors raised before any byte reached Telegram: the request certainly was not delivered. */
const PRE_CONNECT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "ENETUNREACH", "EHOSTUNREACH"]);

function causeCodes(err: unknown): string[] {
  const codes: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    const errors = (cur as { errors?: unknown }).errors;
    if (Array.isArray(errors)) for (const e of errors) if (e && typeof (e as { code?: unknown }).code === "string") codes.push((e as { code: string }).code);
    cur = (cur as { cause?: unknown }).cause;
  }
  return codes;
}

export function classifyTelegramError(err: unknown, idempotent: boolean, attempt: number): FailureClass {
  const backoff = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 500);
  if (err instanceof TelegramApiError) {
    const desc = err.description.toLowerCase();
    if (err.errorCode === 429) {
      return { kind: "retry", afterMs: ((err.retryAfter ?? 1) * 1000) + 250, reason: `rate limited (retry_after=${err.retryAfter})` };
    }
    if (desc.includes("message is not modified")) return { kind: "noop", reason: err.description };
    if (desc.includes("poll has already been closed")) return { kind: "noop", reason: err.description };
    if (err.errorCode >= 500) {
      return idempotent ? { kind: "retry", afterMs: backoff, reason: err.description } : { kind: "uncertain", reason: `telegram ${err.errorCode}: ${err.description}` };
    }
    return { kind: "fatal", reason: `telegram ${err.errorCode}: ${err.description}` };
  }
  const codes = causeCodes(err);
  if (codes.some((c) => PRE_CONNECT_CODES.has(c))) {
    return { kind: "retry", afterMs: backoff, reason: `network (not sent): ${codes.join(",")}` };
  }
  if (err instanceof TimeoutError || err instanceof NetworkError) {
    return idempotent
      ? { kind: "retry", afterMs: backoff, reason: (err as Error).message }
      : { kind: "uncertain", reason: `${(err as Error).name}: ${(err as Error).message}` };
  }
  return idempotent ? { kind: "retry", afterMs: backoff, reason: String(err) } : { kind: "uncertain", reason: String(err) };
}
