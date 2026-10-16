/**
 * Telegram Bot API limits verified against https://core.telegram.org/bots/api (Bot API 10.3, Aug 2026):
 * - sendMessage / editMessageText text: 1-4096 characters after entities parsing
 * - photo caption / editMessageCaption: 0-1024 characters after entities parsing
 * - sendPoll question: 1-300 characters; options: 1-12 items, each 1-100 characters;
 *   explanation 0-200 characters with at most 2 line feeds; correct_option_ids is now an array
 * - InlineKeyboardButton.callback_data: 1-64 bytes
 * - answerCallbackQuery text: 0-200 characters
 * - deep link start parameter: up to 64 base64url characters
 * - getFile download: up to 20 MB
 * - setWebhook secret_token: 1-256 chars of A-Z a-z 0-9 _ -
 */
export const TG = {
  MESSAGE_MAX: 4096,
  CAPTION_MAX: 1024,
  POLL_QUESTION_MAX: 300,
  POLL_OPTION_MAX: 100,
  POLL_OPTIONS_MIN: 1,
  POLL_OPTIONS_MAX: 12,
  POLL_EXPLANATION_MAX: 200,
  CALLBACK_DATA_MAX_BYTES: 64,
  CALLBACK_ANSWER_MAX: 200,
  START_PARAM_MAX: 64,
  GET_FILE_MAX_BYTES: 20 * 1024 * 1024,
  /** Our own readability limit for inline answer buttons (not a Telegram limit). */
  BUTTON_TEXT_SOFT_MAX: 40,
  /** Report parts are split below the hard limit to leave room for the part header. */
  REPORT_PART_MAX: 3800,
} as const;

/** Telegram counts length in UTF-16 code units for text limits. */
export function tgLength(s: string): number {
  return s.length;
}

export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
