import { NetworkError, TelegramApiError, TimeoutError } from "node-telegram-bot-api";
import { describe, expect, it } from "vitest";
import { renderDailyReport, splitReport } from "../../src/domain/reportFormat.js";
import { engineFor } from "../../src/games/engines.js";
import { CallbackCodec } from "../../src/telegram/callbackData.js";
import { classifyTelegramError } from "../../src/telegram/errors.js";

describe("signed callback data", () => {
  const codec = new CallbackCodec("secret-0123456789abcdef");
  it("round-trips and stays within 64 bytes", () => {
    const data = codec.encode("a", 123456789, 3);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(codec.decode(data)).toEqual({ kind: "a", args: ["123456789", "3"] });
  });
  it("rejects forged or tampered data", () => {
    const data = codec.encode("a", 5, 1);
    expect(codec.decode(data.replace(":5:", ":6:"))).toBeNull();
    expect(codec.decode("a:5:1:AAAAAAAAAA")).toBeNull();
    expect(new CallbackCodec("other-secret-xxxxxxxx").decode(data)).toBeNull();
  });
});

describe("Telegram HTML validation (fake mirrors the real parser)", () => {
  it("accepts supported, balanced, escaped HTML and rejects the rest", async () => {
    const { validateTelegramHtml } = await import("../../src/telegram/fakeTelegram.js");
    expect(validateTelegramHtml(`<b>Ali &amp; Vali</b> <pre><code class="language-js">a &lt;= b</code></pre>`)).toBeNull();
    expect(validateTelegramHtml("a <= b")).toMatch(/unescaped/);
    expect(validateTelegramHtml("<b>open")).toMatch(/unclosed/);
    expect(validateTelegramHtml("<div>x</div>")).toMatch(/unsupported/);
  });
});

describe("Telegram failure classification", () => {
  it("honours retry_after on 429", () => {
    const r = classifyTelegramError(new TelegramApiError(429, "Too Many Requests", { retry_after: 7 }), false, 1);
    expect(r.kind).toBe("retry");
    expect(r.kind === "retry" && r.afterMs).toBeGreaterThanOrEqual(7000);
  });
  it("treats a timeout on a send as uncertain (never blindly resent) but retries idempotent edits", () => {
    expect(classifyTelegramError(new TimeoutError("t"), false, 1).kind).toBe("uncertain");
    expect(classifyTelegramError(new TimeoutError("t"), true, 1).kind).toBe("retry");
  });
  it("retries errors raised before the request left (DNS / connection refused)", () => {
    const err = new NetworkError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) });
    expect(classifyTelegramError(err, false, 1).kind).toBe("retry");
  });
  it("treats 'message is not modified' as done and 400s as fatal", () => {
    expect(classifyTelegramError(new TelegramApiError(400, "Bad Request: message is not modified"), true, 1).kind).toBe("noop");
    expect(classifyTelegramError(new TelegramApiError(400, "Bad Request: chat not found"), false, 1).kind).toBe("fatal");
  });
});

describe("game rendering", () => {
  const codec = new CallbackCodec("secret-0123456789abcdef");
  const base = { instanceId: 42, chatId: -100, lang: "uz" as const, slotNumber: 1, totalSlots: 6, secondsLeft: 600, answerMinutes: 10, hideResults: true, codec, botUsername: "bot" };
  it("sends non-anonymous quiz polls with one correct option and no early explanation", () => {
    const out = engineFor("quiz_poll").render({ ...base, content: { prompt: "Qaysi metod?", options: ["push", "pop", "map", "sort"], correctIndex: 2, explanation: "e" } });
    expect(out.method).toBe("sendPoll");
    expect(out.payload).toMatchObject({ type: "quiz", is_anonymous: false, allows_revoting: false, correct_option_ids: [2], open_period: 600 });
    expect(out.payload).not.toHaveProperty("explanation");
  });
  it("true/false polls have exactly two options", () => {
    const out = engineFor("true_false").render({ ...base, content: { statement: "push oxiriga qo'shadi.", isTrue: false, explanation: "e" } });
    expect((out.payload.options as unknown[]).length).toBe(2);
    expect(out.payload.correct_option_ids).toEqual([1]);
  });
  it("emoji/picture buttons are the same for everyone and carry signed data", () => {
    const out = engineFor("emoji_puzzle").render({ ...base, content: { emojis: "🍎🍌", category: "Guruh", options: ["Mevalar", "Hayvon", "Rang", "Son"], correctIndex: 0, explanation: "e" } });
    const kb = (out.payload.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard.flat();
    expect(kb).toHaveLength(4);
    expect(kb.map((b) => codec.decode(b.callback_data)?.args)).toEqual([["42", "0"], ["42", "1"], ["42", "2"], ["42", "3"]]);
  });
  it("text games use a deep-link answer button", () => {
    const out = engineFor("guess_word").render({ ...base, content: { answer: "massiv", acceptedVariants: [], clues: ["birinchi maslahat", "ikkinchi maslahat", "uchinchi maslahat"], explanation: "e" } });
    const btn = (out.payload.reply_markup as { inline_keyboard: { url: string }[][] }).inline_keyboard[0]![0]!;
    expect(btn.url).toBe("https://t.me/bot?start=a_42");
    expect(String(out.payload.text)).not.toContain("massiv");
  });
});

describe("report rendering", () => {
  it("matches the example facts and escapes names", () => {
    const parts = renderDailyReport({
      lang: "uz",
      localDate: "2026-10-19",
      topic: "JavaScript massivlari",
      gameType: "quiz_poll",
      canceled: false,
      inactive: [],
      rows: [
        { studentId: 1, name: "Madina", points: 55, correct: 5, wrong: 1, unanswered: 0, pending: 0, bonus: 0 },
        { studentId: 2, name: "Ali", points: 45, correct: 4, wrong: 1, unanswered: 1, pending: 0, bonus: 0 },
        { studentId: 3, name: "Umar <b>", points: 0, correct: 0, wrong: 0, unanswered: 6, pending: 0, bonus: 0 },
      ],
    });
    expect(parts).toHaveLength(1);
    const text = parts[0]!;
    expect(text).toContain("Bugungi natijalar");
    expect(text).toContain("Mavzu: JavaScript massivlari");
    expect(text).toContain("<b>Madina</b>: 55 ball, 5 to'g'ri, 1 xato");
    expect(text).toContain("<b>Ali</b>: 45 ball, 4 to'g'ri, 1 xato, 1 javobsiz");
    expect(text).toContain("Umar &lt;b&gt;</b>: 0 ball, 6 javobsiz");
  });
  it("splits large reports deterministically into numbered parts under the limit", () => {
    const body = Array.from({ length: 400 }, (_, i) => `${i + 1}. <b>O'quvchi ${i}</b>: ${i} ball, 3 to'g'ri`);
    const a = splitReport("uz", ["Title"], body, []);
    const b = splitReport("uz", ["Title"], body, []);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1);
    expect(a.every((p) => p.length <= 3900)).toBe(true);
    expect(a[0]!.startsWith(`(1/${a.length})`)).toBe(true);
  });
});
