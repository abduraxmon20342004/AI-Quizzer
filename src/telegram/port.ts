import type {
  AnswerCallbackQueryParams,
  ChatMember,
  EditMessageReplyMarkupParams,
  EditMessageTextParams,
  File as TgFile,
  GetChatMemberParams,
  Message,
  Poll,
  SendMessageParams,
  SendPhotoParams,
  SendPollParams,
  StopPollParams,
  Update,
  User,
} from "node-telegram-bot-api";

/**
 * The narrow slice of the Bot API this project uses. The real adapter wraps node-telegram-bot-api v2;
 * tests and the simulator use FakeTelegram. Photos are always sent by file_id (string).
 */
export interface TelegramPort {
  getMe(): Promise<User>;
  sendMessage(p: SendMessageParams): Promise<Message>;
  sendPoll(p: SendPollParams): Promise<Message>;
  sendPhoto(p: Omit<SendPhotoParams, "photo"> & { photo: string }): Promise<Message>;
  stopPoll(p: StopPollParams): Promise<Poll>;
  editMessageText(p: EditMessageTextParams): Promise<Message | boolean>;
  editMessageReplyMarkup(p: EditMessageReplyMarkupParams): Promise<Message | boolean>;
  answerCallbackQuery(p: AnswerCallbackQueryParams): Promise<boolean>;
  getChatMember(p: GetChatMemberParams): Promise<ChatMember>;
  getChatMemberCount(p: { chat_id: number | string }): Promise<number>;
  getFile(p: { file_id: string }): Promise<TgFile>;
  /** Download a file by its getFile path, refusing anything larger than maxBytes. */
  downloadFile(filePath: string, maxBytes: number): Promise<Uint8Array>;
}

export type { Update, Message, User, Poll, ChatMember };

/** Outbox-dispatchable methods (payload = the method's params object). */
export const OUTBOX_METHODS = ["sendMessage", "sendPoll", "sendPhoto", "stopPoll", "editMessageText", "editMessageReplyMarkup"] as const;
export type OutboxMethod = (typeof OUTBOX_METHODS)[number];

/** Methods that are safe to repeat (repeating cannot create a duplicate visible message). */
export const IDEMPOTENT_METHODS: ReadonlySet<OutboxMethod> = new Set(["stopPoll", "editMessageText", "editMessageReplyMarkup"]);

export async function callOutboxMethod(tg: TelegramPort, method: OutboxMethod, payload: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "sendMessage":
      return tg.sendMessage(payload as SendMessageParams);
    case "sendPoll":
      return tg.sendPoll(payload as SendPollParams);
    case "sendPhoto":
      return tg.sendPhoto(payload as Omit<SendPhotoParams, "photo"> & { photo: string });
    case "stopPoll":
      return tg.stopPoll(payload as StopPollParams);
    case "editMessageText":
      return tg.editMessageText(payload as EditMessageTextParams);
    case "editMessageReplyMarkup":
      return tg.editMessageReplyMarkup(payload as EditMessageReplyMarkupParams);
  }
}
