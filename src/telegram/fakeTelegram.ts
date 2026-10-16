import { NetworkError, TelegramApiError, TimeoutError } from "node-telegram-bot-api";
import type { ChatMember, Message, Poll, TelegramPort, User } from "./port.js";

/**
 * In-memory Telegram used by tests, the simulator and the load test (APP_MODE demo/test only).
 * It records every call and supports failure injection, including "accepted then timed out".
 */
export interface FakeSent {
  method: string;
  chatId: number;
  messageId: number;
  text?: string;
  payload: Record<string, unknown>;
  pollId?: string;
  at: Date;
}

type Failure = "timeout_after_accept" | "timeout_before_send" | "network_before_send" | "rate_limit" | "fatal";

const HTML_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "span", "tg-spoiler", "a", "code", "pre", "blockquote", "tg-emoji"]);

/**
 * Mirrors Telegram's HTML parse mode rules closely enough for tests: only supported tags, properly nested,
 * and literal <, > and & must be escaped. Real Telegram answers 400 "can't parse entities" otherwise.
 */
export function validateTelegramHtml(text: string): string | null {
  const stack: string[] = [];
  const re = /<(\/?)([a-zA-Z-]+)((?:\s[^<>]*)?)>|&(#\d+|#x[0-9a-fA-F]+|lt|gt|amp|quot);|[<>&]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[2]) {
      const tag = m[2].toLowerCase();
      if (!HTML_TAGS.has(tag)) return `unsupported tag <${tag}>`;
      if (m[1]) {
        if (stack.pop() !== tag) return `unbalanced </${tag}>`;
      } else stack.push(tag);
    } else if (!m[4]) {
      return `unescaped "${m[0]}" at ${m.index}`;
    }
  }
  return stack.length ? `unclosed <${stack[stack.length - 1]}>` : null;
}

export class FakeTelegram implements TelegramPort {
  readonly sent: FakeSent[] = [];
  readonly edits: { method: string; chatId: number; messageId: number; payload: Record<string, unknown> }[] = [];
  readonly callbackAnswers: { id: string; text?: string }[] = [];
  readonly stoppedPolls: string[] = [];
  private nextMessageId = 1000;
  private nextPoll = 1;
  private failures: { method: string; failure: Failure }[] = [];
  /** chat_id -> user_id -> status */
  readonly members = new Map<number, Map<number, string>>();
  readonly files = new Map<string, { path: string; bytes: Uint8Array }>();
  now: () => Date = () => new Date();

  constructor(readonly me: User = { id: 999_000_001, is_bot: true, first_name: "GameBot", username: "test_game_bot" }) {}

  failNext(method: string, failure: Failure): void {
    this.failures.push({ method, failure });
  }

  private maybeFail(method: string): Failure | null {
    const i = this.failures.findIndex((f) => f.method === method);
    if (i < 0) return null;
    const [f] = this.failures.splice(i, 1);
    const failure = f!.failure;
    if (failure === "timeout_before_send") throw new TimeoutError("client timeout");
    if (failure === "network_before_send") {
      throw new NetworkError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
    }
    if (failure === "rate_limit") throw new TelegramApiError(429, "Too Many Requests: retry after 1", { retry_after: 1 });
    if (failure === "fatal") throw new TelegramApiError(400, "Bad Request: chat not found");
    return failure; // timeout_after_accept: deliver, then throw
  }

  private checkHtml(payload: Record<string, unknown>): void {
    if (payload.parse_mode !== "HTML") return;
    const text = String(payload.text ?? payload.caption ?? "");
    const problem = validateTelegramHtml(text);
    if (problem) throw new TelegramApiError(400, `Bad Request: can't parse entities: ${problem}`);
    if (text.replace(/<[^>]+>/g, "").length > (payload.caption !== undefined ? 1024 : 4096)) throw new TelegramApiError(400, "Bad Request: message is too long");
  }

  private record(method: string, payload: Record<string, unknown>, extra: Partial<FakeSent> = {}): Message {
    this.checkHtml(payload);
    const failure = this.maybeFail(method);
    const chatId = Number(payload.chat_id);
    const messageId = this.nextMessageId++;
    const text = (payload.text ?? payload.question ?? payload.caption) as string | undefined;
    this.sent.push({ method, chatId, messageId, payload, at: this.now(), ...(text !== undefined ? { text } : {}), ...extra });
    if (failure === "timeout_after_accept") throw new TimeoutError("timed out after Telegram accepted the request");
    const msg = { message_id: messageId, date: Math.floor(this.now().getTime() / 1000), chat: { id: chatId, type: chatId < 0 ? "supergroup" : "private" } } as Message;
    if (extra.pollId) {
      (msg as Message & { poll: Poll }).poll = { id: extra.pollId, question: String(payload.question), options: [], total_voter_count: 0, is_closed: false, is_anonymous: false, type: "quiz", allows_multiple_answers: false } as unknown as Poll;
    }
    return msg;
  }

  async getMe(): Promise<User> {
    return this.me;
  }
  async sendMessage(p: Parameters<TelegramPort["sendMessage"]>[0]): Promise<Message> {
    return this.record("sendMessage", p as unknown as Record<string, unknown>);
  }
  async sendPoll(p: Parameters<TelegramPort["sendPoll"]>[0]): Promise<Message> {
    return this.record("sendPoll", p as unknown as Record<string, unknown>, { pollId: `poll-${this.nextPoll++}` });
  }
  async sendPhoto(p: Parameters<TelegramPort["sendPhoto"]>[0]): Promise<Message> {
    return this.record("sendPhoto", p as unknown as Record<string, unknown>);
  }
  async stopPoll(p: Parameters<TelegramPort["stopPoll"]>[0]): Promise<Poll> {
    this.maybeFail("stopPoll");
    this.stoppedPolls.push(`${p.chat_id}:${p.message_id}`);
    return { id: "stopped", is_closed: true } as unknown as Poll;
  }
  async editMessageText(p: Parameters<TelegramPort["editMessageText"]>[0]): Promise<Message | boolean> {
    this.checkHtml(p as unknown as Record<string, unknown>);
    this.maybeFail("editMessageText");
    this.edits.push({ method: "editMessageText", chatId: Number(p!.chat_id), messageId: Number(p!.message_id), payload: p as unknown as Record<string, unknown> });
    return true;
  }
  async editMessageReplyMarkup(p: Parameters<TelegramPort["editMessageReplyMarkup"]>[0]): Promise<Message | boolean> {
    this.maybeFail("editMessageReplyMarkup");
    this.edits.push({ method: "editMessageReplyMarkup", chatId: Number(p!.chat_id), messageId: Number(p!.message_id), payload: p as unknown as Record<string, unknown> });
    return true;
  }
  async answerCallbackQuery(p: Parameters<TelegramPort["answerCallbackQuery"]>[0]): Promise<boolean> {
    this.callbackAnswers.push({ id: p.callback_query_id, ...(p.text ? { text: p.text } : {}) });
    return true;
  }
  async getChatMember(p: Parameters<TelegramPort["getChatMember"]>[0]): Promise<ChatMember> {
    const status = this.members.get(Number(p.chat_id))?.get(p.user_id) ?? "left";
    return { status, user: { id: p.user_id, is_bot: false, first_name: `User${p.user_id}` } } as ChatMember;
  }
  async getChatMemberCount(p: { chat_id: number | string }): Promise<number> {
    return (this.members.get(Number(p.chat_id))?.size ?? 0) + 1;
  }
  async getFile(p: { file_id: string }) {
    const f = this.files.get(p.file_id);
    if (!f) throw new TelegramApiError(400, "Bad Request: invalid file_id");
    return { file_id: p.file_id, file_unique_id: p.file_id, file_size: f.bytes.byteLength, file_path: f.path };
  }
  async downloadFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
    for (const f of this.files.values()) {
      if (f.path === filePath) {
        if (f.bytes.byteLength > maxBytes) throw new Error("file too large");
        return f.bytes;
      }
    }
    throw new Error("not found");
  }

  messagesTo(chatId: number): FakeSent[] {
    return this.sent.filter((s) => s.chatId === chatId);
  }
}
