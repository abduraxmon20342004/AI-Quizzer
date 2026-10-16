import { createHmac, timingSafeEqual } from "node:crypto";
import { TG, utf8Bytes } from "../domain/telegramLimits.js";

/**
 * Compact signed callback data: "kind:arg1:arg2:sig". The HMAC tag (10 base64url chars) makes forged or
 * tampered button payloads detectable; every value is still re-validated against the database.
 * Telegram limits callback_data to 64 bytes.
 */
export class CallbackCodec {
  constructor(private readonly secret: string) {}

  private sign(payload: string): string {
    return createHmac("sha256", this.secret).update(payload).digest("base64url").slice(0, 10);
  }

  encode(kind: string, ...args: (string | number)[]): string {
    const parts = [kind, ...args.map(String)];
    for (const p of parts) if (p.includes(":")) throw new Error("callback part must not contain ':'");
    const payload = parts.join(":");
    const data = `${payload}:${this.sign(payload)}`;
    if (utf8Bytes(data) > TG.CALLBACK_DATA_MAX_BYTES) throw new Error(`callback data too long: ${data}`);
    return data;
  }

  decode(data: string | undefined): { kind: string; args: string[] } | null {
    if (!data || utf8Bytes(data) > TG.CALLBACK_DATA_MAX_BYTES) return null;
    const idx = data.lastIndexOf(":");
    if (idx <= 0) return null;
    const payload = data.slice(0, idx);
    const sig = Buffer.from(data.slice(idx + 1));
    const expected = Buffer.from(this.sign(payload));
    if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
    const [kind, ...args] = payload.split(":");
    return kind ? { kind, args } : null;
  }
}

/** Parse a positive safe integer argument, or null. */
export function intArg(s: string | undefined): number | null {
  if (!s || !/^\d{1,16}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function intArg0(s: string | undefined): number | null {
  if (s === "0") return 0;
  return intArg(s);
}
