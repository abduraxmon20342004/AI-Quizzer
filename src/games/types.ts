import type { AnyContent } from "../domain/content.js";
import type { GameType } from "../domain/gameTypes.js";
import type { Lang } from "../i18n/index.js";
import type { CallbackCodec } from "../telegram/callbackData.js";
import type { OutboxMethod } from "../telegram/port.js";

export interface RenderArgs {
  instanceId: number;
  chatId: number;
  lang: Lang;
  content: AnyContent;
  slotNumber: number;
  totalSlots: number;
  /** Seconds remaining until the server-side deadline at the moment of rendering. */
  secondsLeft: number;
  answerMinutes: number;
  hideResults: boolean;
  codec: CallbackCodec;
  botUsername: string;
  /** Telegram file_id for picture questions (resolved from picture_assets). */
  photoFileId?: string;
}

export interface Outgoing {
  method: OutboxMethod;
  payload: Record<string, unknown>;
}

export interface CloseArgs {
  chatId: number;
  messageId: number | null;
  lang: Lang;
  content: AnyContent;
}

export type DeterministicVerdict = "correct" | "incorrect" | "needs_ai";

export interface StudentAnswer {
  optionIndex?: number | null;
  text?: string | null;
}

export interface GradeOptions {
  aiGradingEnabled: boolean;
}

export interface GameEngine {
  type: GameType;
  render(a: RenderArgs): Outgoing;
  /** Telegram actions that close the question (stop the poll, remove buttons). */
  closeActions(a: CloseArgs): Outgoing[];
  /** Post-closure message revealing the answer and explanation. */
  reveal(a: CloseArgs): Outgoing;
  grade(content: AnyContent, answer: StudentAnswer, opts: GradeOptions): DeterministicVerdict;
  /** Human-readable correct answer (admin review). */
  answerSummary(content: AnyContent, lang: Lang): string;
}
