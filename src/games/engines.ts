import type { ContentOf } from "../domain/content.js";
import type { GameType } from "../domain/gameTypes.js";
import { codeKey, levenshtein, normalizeWord, uzCyrillicToLatin } from "../domain/normalize.js";
import { TG, escapeHtml } from "../domain/telegramLimits.js";
import { gameIcon, gameName, t, tfLabels, type Lang } from "../i18n/index.js";
import type { CloseArgs, GameEngine, Outgoing, RenderArgs } from "./types.js";

// ---------------------------------------------------------------- shared helpers

function header(a: RenderArgs, type: GameType): string {
  return `${gameIcon(type)} <b>${escapeHtml(gameName(a.lang, type))}</b> · ${t(a.lang, "questionOf", { n: a.slotNumber, total: a.totalSlots })} · ${t(a.lang, "timeLimit", { min: a.answerMinutes })}`;
}

function replyTo(messageId: number | null) {
  return messageId ? { reply_parameters: { message_id: messageId, allow_sending_without_reply: true } } : {};
}

function revealMessage(a: CloseArgs, answerHtml: string, explanation: string): Outgoing {
  const text = `${t(a.lang, "closedAnswer", { answer: answerHtml })}\n${t(a.lang, "explanation", { text: escapeHtml(explanation) })}`;
  return { method: "sendMessage", payload: { chat_id: a.chatId, text: text.slice(0, TG.MESSAGE_MAX), parse_mode: "HTML", ...replyTo(a.messageId) } };
}

function removeKeyboard(a: CloseArgs): Outgoing[] {
  if (!a.messageId) return [];
  return [{ method: "editMessageReplyMarkup", payload: { chat_id: a.chatId, message_id: a.messageId, reply_markup: { inline_keyboard: [] } } }];
}

function stopPoll(a: CloseArgs): Outgoing[] {
  if (!a.messageId) return [];
  return [{ method: "stopPoll", payload: { chat_id: a.chatId, message_id: a.messageId } }];
}

/** 2x2 grid of answer buttons with signed callback data. Same keyboard for everyone (no per-student state). */
function optionKeyboard(a: RenderArgs, options: string[]) {
  const buttons = options.map((text, i) => ({ text, callback_data: a.codec.encode("a", a.instanceId, i) }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { inline_keyboard: rows };
}

function deepLinkKeyboard(a: RenderArgs) {
  return { inline_keyboard: [[{ text: t(a.lang, "answerButton"), url: `https://t.me/${a.botUsername}?start=a_${a.instanceId}` }]] };
}

function pollPayload(a: RenderArgs, question: string, options: string[], correctIndex: number): Outgoing {
  const prefix = `${a.slotNumber}/${a.totalSlots}. `;
  const q = (prefix + question).length <= TG.POLL_QUESTION_MAX ? prefix + question : question;
  return {
    method: "sendPoll",
    payload: {
      chat_id: a.chatId,
      question: q,
      options: options.map((text) => ({ text })),
      type: "quiz",
      // Non-anonymous so each student's poll_answer reaches the bot; quiz polls do not allow revoting.
      is_anonymous: false,
      allows_revoting: false,
      correct_option_ids: [correctIndex],
      ...(a.hideResults ? { hide_results_until_closes: true } : {}),
      // The explanation is posted after closing, not inside the poll, so it is not shown early.
      ...(a.secondsLeft >= 5 && a.secondsLeft <= 2_628_000 ? { open_period: a.secondsLeft } : {}),
    },
  };
}

function choiceGrade(correctIndex: number, optionIndex: number | null | undefined): "correct" | "incorrect" {
  return optionIndex === correctIndex ? "correct" : "incorrect";
}

// ---------------------------------------------------------------- engines

const quizPoll: GameEngine = {
  type: "quiz_poll",
  render(a) {
    const c = a.content as ContentOf<"quiz_poll">;
    return pollPayload(a, c.prompt, c.options, c.correctIndex);
  },
  closeActions: stopPoll,
  reveal(a) {
    const c = a.content as ContentOf<"quiz_poll">;
    return revealMessage(a, `<b>${escapeHtml(c.options[c.correctIndex]!)}</b>`, c.explanation);
  },
  grade: (content, ans) => choiceGrade((content as ContentOf<"quiz_poll">).correctIndex, ans.optionIndex),
  answerSummary: (content) => {
    const c = content as ContentOf<"quiz_poll">;
    return c.options[c.correctIndex]!;
  },
};

const trueFalse: GameEngine = {
  type: "true_false",
  render(a) {
    const c = a.content as ContentOf<"true_false">;
    return pollPayload(a, c.statement, tfLabels(a.lang), c.isTrue ? 0 : 1);
  },
  closeActions: stopPoll,
  reveal(a) {
    const c = a.content as ContentOf<"true_false">;
    return revealMessage(a, `<b>${escapeHtml(tfLabels(a.lang)[c.isTrue ? 0 : 1])}</b>`, c.explanation);
  },
  grade: (content, ans) => choiceGrade((content as ContentOf<"true_false">).isTrue ? 0 : 1, ans.optionIndex),
  answerSummary: (content, lang) => tfLabels(lang)[(content as ContentOf<"true_false">).isTrue ? 0 : 1],
};

const findMistake: GameEngine = {
  type: "find_mistake",
  render(a) {
    const c = a.content as ContentOf<"find_mistake">;
    const lang = escapeHtml(c.codeLanguage.toLowerCase().replace(/[^a-z0-9+#-]/g, ""));
    const text = `${header(a, "find_mistake")}\n\n${escapeHtml(c.prompt)}\n<pre><code class="language-${lang}">${escapeHtml(c.code)}</code></pre>`;
    return { method: "sendMessage", payload: { chat_id: a.chatId, text, parse_mode: "HTML", reply_markup: deepLinkKeyboard(a) } };
  },
  closeActions: removeKeyboard,
  reveal(a) {
    const c = a.content as ContentOf<"find_mistake">;
    const text =
      `${t(a.lang, "closedAnswer", { answer: escapeHtml(c.mistakeDescription) })}\n` +
      `${t(a.lang, "correctFix")}\n<pre>${escapeHtml(c.fixedCode)}</pre>\n${t(a.lang, "explanation", { text: escapeHtml(c.explanation) })}`;
    return { method: "sendMessage", payload: { chat_id: a.chatId, text: text.slice(0, TG.MESSAGE_MAX), parse_mode: "HTML", ...replyTo(a.messageId) } };
  },
  grade(content, ans, opts) {
    const c = content as ContentOf<"find_mistake">;
    const text = ans.text ?? "";
    if (!text.trim()) return "incorrect";
    const key = codeKey(text, c.codeLanguage);
    if (key === codeKey(c.code, c.codeLanguage)) return "incorrect"; // unchanged buggy code
    const accepted = [c.fixedCode, ...c.acceptedFixes].map((f) => codeKey(f, c.codeLanguage));
    if (accepted.includes(key)) return "correct";
    // Equivalent fixes written differently need the rubric: AI grading, or admin review when AI is off
    // (the caller maps needs_ai to needs_review when AI grading is disabled).
    void opts;
    return "needs_ai";
  },
  answerSummary: (content) => (content as ContentOf<"find_mistake">).fixedCode,
};

/** Guess the word: exact variants are deterministic; near misses go to AI (spelling / Uzbek script variants). */
export function guessWordVerdict(c: ContentOf<"guess_word">, text: string, aiEnabled: boolean): "correct" | "incorrect" | "needs_ai" {
  const guess = normalizeWord(text);
  if (!guess) return "incorrect";
  const accepted = [c.answer, ...c.acceptedVariants].map(normalizeWord);
  if (accepted.includes(guess) || accepted.includes(normalizeWord(uzCyrillicToLatin(text)))) return "correct";
  if (!aiEnabled) return "incorrect";
  const close = accepted.some((a) => {
    const tolerance = Math.max(1, Math.floor(a.length / 5));
    return levenshtein(a, guess) <= tolerance || (a.length >= 4 && guess.split(" ").includes(a));
  });
  return close ? "needs_ai" : "incorrect";
}

const guessWord: GameEngine = {
  type: "guess_word",
  render(a) {
    const c = a.content as ContentOf<"guess_word">;
    const text = `${header(a, "guess_word")}\n\n<b>${t(a.lang, "clue", { n: 1 })}:</b> ${escapeHtml(c.clues[0])}`;
    return { method: "sendMessage", payload: { chat_id: a.chatId, text, parse_mode: "HTML", reply_markup: deepLinkKeyboard(a) } };
  },
  closeActions: removeKeyboard,
  reveal(a) {
    const c = a.content as ContentOf<"guess_word">;
    return revealMessage(a, `<b>${escapeHtml(c.answer)}</b>`, c.explanation);
  },
  grade(content, ans, opts) {
    return guessWordVerdict(content as ContentOf<"guess_word">, ans.text ?? "", opts.aiGradingEnabled);
  },
  answerSummary: (content) => (content as ContentOf<"guess_word">).answer,
};

export function renderClue(lang: Lang, chatId: number, messageId: number | null, content: ContentOf<"guess_word">, stage: 2 | 3): Outgoing {
  const text = `🔤 <b>${t(lang, "clue", { n: stage })}:</b> ${escapeHtml(content.clues[stage - 1]!)}`;
  return { method: "sendMessage", payload: { chat_id: chatId, text, parse_mode: "HTML", ...replyTo(messageId) } };
}

const pictureQuiz: GameEngine = {
  type: "picture_quiz",
  render(a) {
    const c = a.content as ContentOf<"picture_quiz">;
    if (!a.photoFileId) throw new Error("picture asset file_id missing");
    const caption = `${header(a, "picture_quiz")}\n\n${escapeHtml(c.prompt)}`.slice(0, TG.CAPTION_MAX);
    return { method: "sendPhoto", payload: { chat_id: a.chatId, photo: a.photoFileId, caption, parse_mode: "HTML", reply_markup: optionKeyboard(a, c.options) } };
  },
  closeActions: removeKeyboard,
  reveal(a) {
    const c = a.content as ContentOf<"picture_quiz">;
    return revealMessage(a, `<b>${escapeHtml(c.options[c.correctIndex]!)}</b>`, c.explanation);
  },
  grade: (content, ans) => choiceGrade((content as ContentOf<"picture_quiz">).correctIndex, ans.optionIndex),
  answerSummary: (content) => {
    const c = content as ContentOf<"picture_quiz">;
    return c.options[c.correctIndex]!;
  },
};

const emojiPuzzle: GameEngine = {
  type: "emoji_puzzle",
  render(a) {
    const c = a.content as ContentOf<"emoji_puzzle">;
    const text = `${header(a, "emoji_puzzle")}\n\n<b>${escapeHtml(c.emojis)}</b>\n${escapeHtml(c.category)}`;
    return { method: "sendMessage", payload: { chat_id: a.chatId, text, parse_mode: "HTML", reply_markup: optionKeyboard(a, c.options) } };
  },
  closeActions: removeKeyboard,
  reveal(a) {
    const c = a.content as ContentOf<"emoji_puzzle">;
    return revealMessage(a, `<b>${escapeHtml(c.options[c.correctIndex]!)}</b>`, c.explanation);
  },
  grade: (content, ans) => choiceGrade((content as ContentOf<"emoji_puzzle">).correctIndex, ans.optionIndex),
  answerSummary: (content) => {
    const c = content as ContentOf<"emoji_puzzle">;
    return `${c.emojis} → ${c.options[c.correctIndex]}`;
  },
};

export const ENGINES: Record<GameType, GameEngine> = {
  quiz_poll: quizPoll,
  true_false: trueFalse,
  find_mistake: findMistake,
  guess_word: guessWord,
  picture_quiz: pictureQuiz,
  emoji_puzzle: emojiPuzzle,
};

export function engineFor(t: GameType): GameEngine {
  return ENGINES[t];
}
