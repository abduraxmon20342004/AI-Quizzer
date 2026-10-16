import type { AppContext } from "../app/context.js";
import type { Executor, Tx } from "../db/db.js";
import type { Row, Verdict } from "../db/schema.js";
import type { ContentOf } from "../domain/content.js";
import { escapeHtml } from "../domain/telegramLimits.js";
import { engineFor } from "../games/engines.js";
import type { DeterministicVerdict } from "../games/types.js";
import { t, type Lang } from "../i18n/index.js";
import type { User } from "../telegram/port.js";
import { getSettings } from "./groups.js";
import { acceptsAnswers, loadInstance, type LoadedInstance } from "./instances.js";
import { discoverStudent, getStudentByUser, isEligible, upsertTelegramUser } from "./roster.js";
import { recomputeResult } from "./scoring.js";

/**
 * Answer intake. Every submission is checked server-side: Telegram identity, group membership and
 * eligibility, question id/state, correct group chat, and the server-side deadline using the time the
 * update was received (client clocks are never trusted). The first final answer is locked by the
 * UNIQUE (instance_id, student_id, stage) constraint - later duplicates are ignored atomically.
 * Acknowledgements never reveal correctness.
 */

export const MAX_TEXT_ANSWER = 2000;

export type IntakeOutcome = "accepted" | "duplicate" | "late" | "not_eligible" | "invalid" | "stage_taken" | "ignored";

async function insertSubmission(
  ex: Executor,
  v: { instanceId: number; groupId: number; studentId: number; stage: number; kind: "poll" | "button" | "text"; optionIndex?: number | null; text?: string | null; receivedAt: Date },
): Promise<Row<"submissions"> | null> {
  const row = await ex
    .insertInto("submissions")
    .values({
      instance_id: v.instanceId,
      group_id: v.groupId,
      student_id: v.studentId,
      stage: v.stage,
      kind: v.kind,
      option_index: v.optionIndex ?? null,
      answer_text: v.text ?? null,
      received_at: v.receivedAt,
    })
    .onConflict((oc) => oc.columns(["instance_id", "student_id", "stage"]).doNothing())
    .returningAll()
    .executeTakeFirst();
  return row ?? null;
}

/** Store a deterministic verdict, or queue AI grading (pending) / admin review when needed. */
async function gradeAndRecord(ctx: AppContext, tx: Tx, li: LoadedInstance, sub: Row<"submissions">, det: DeterministicVerdict): Promise<void> {
  let verdict: Verdict;
  let method: "deterministic" | "system" = "deterministic";
  let reason: string | null = null;
  if (det === "needs_ai") {
    const settings = await getSettings(ctx, tx, li.groupId);
    if (settings.aiGradingEnabled && ctx.ai.name !== "none") {
      verdict = "pending";
      method = "system";
      reason = "queued for AI grading";
      await ctx.jobs.send("answers.grade", { submissionId: sub.id }, { singletonKey: `grade:${sub.id}` }, tx);
    } else {
      verdict = "needs_review";
      method = "system";
      reason = "AI grading disabled: admin review required";
    }
  } else {
    verdict = det;
  }
  await tx
    .updateTable("submissions")
    .set({ verdict, graded_by: verdict === "pending" || verdict === "needs_review" ? null : "deterministic", grading_reason: reason, graded_at: verdict === "pending" ? null : ctx.clock.now() })
    .where("id", "=", sub.id)
    .execute();
  await tx.insertInto("grading_decisions").values({ submission_id: sub.id, method, verdict, reason }).execute();
  await recomputeResult(ctx, tx, li.inst.id, sub.student_id);
}

/** A delivered-but-uncertain question that receives a valid answer is evidently visible: mark delivered. */
async function confirmDeliveryByEvidence(ctx: AppContext, tx: Tx, li: LoadedInstance): Promise<void> {
  if (li.inst.state === "uncertain" && !li.inst.delivery_confirmed) {
    await tx
      .updateTable("question_instances")
      .set({ state: "open", delivery_confirmed: true, opened_at: li.inst.opened_at ?? li.inst.publish_at, state_reason: "delivery confirmed by student answers", updated_at: ctx.clock.now() })
      .where("id", "=", li.inst.id)
      .where("state", "=", "uncertain")
      .execute();
  }
}

// ---------------------------------------------------------------- quiz / true-false polls

export interface PollAnswerInput {
  pollId: string;
  user: User | undefined;
  optionIds: number[];
  receivedAt: Date;
}

export async function handlePollAnswer(ctx: AppContext, pa: PollAnswerInput): Promise<IntakeOutcome> {
  if (!pa.user || pa.user.is_bot) return "ignored";
  // An empty option list is a retraction; it never opens a second scoring chance.
  if (pa.optionIds.length === 0) return "ignored";
  const user = pa.user;
  return ctx.db.transaction().execute(async (tx) => {
    const instRow = await tx.selectFrom("question_instances").select("id").where("poll_id", "=", pa.pollId).executeTakeFirst();
    if (!instRow) {
      // Unknown poll: possibly a question whose delivery was uncertain. Keep it for later matching.
      await upsertTelegramUser(ctx, tx, user);
      await tx
        .insertInto("orphan_poll_answers")
        .values({ poll_id: pa.pollId, user_id: user.id, option_ids: pa.optionIds, received_at: pa.receivedAt })
        .onConflict((oc) => oc.columns(["poll_id", "user_id"]).doNothing())
        .execute();
      return "ignored";
    }
    return pollAnswerForInstance(ctx, tx, instRow.id, user, pa.optionIds, pa.receivedAt);
  });
}

export async function pollAnswerForInstance(ctx: AppContext, tx: Tx, instanceId: number, user: User, optionIds: number[], receivedAt: Date): Promise<IntakeOutcome> {
  const li = await loadInstance(tx, instanceId);
  if (!li || !li.content || (li.gameType !== "quiz_poll" && li.gameType !== "true_false")) return "invalid";
  if (li.inst.invalidated_at) return "ignored";
  // Polls are stopped at the deadline, so Telegram itself refuses later votes; the grace only covers
  // update delivery delay between the vote and our server.
  const deadline = new Date(li.inst.close_at.getTime() + ctx.cfg.POLL_ANSWER_GRACE_SECONDS * 1000);
  if (!(acceptsAnswers(li.inst.state) || li.inst.state === "closing") || receivedAt > deadline) return "late";
  const student = await discoverStudent(ctx, tx, li.groupId, user, "poll_answer");
  if (!student || !isEligible(student)) return "not_eligible";
  const option = optionIds[0]!;
  const sub = await insertSubmission(tx, { instanceId: li.inst.id, groupId: li.groupId, studentId: student.id, stage: 1, kind: "poll", optionIndex: option, receivedAt });
  if (!sub) return "duplicate";
  const det = engineFor(li.gameType).grade(li.content, { optionIndex: option }, { aiGradingEnabled: false });
  await gradeAndRecord(ctx, tx, li, sub, det);
  ctx.metrics.inc("answers_total");
  return "accepted";
}

// ---------------------------------------------------------------- inline answer buttons

export async function handleAnswerButton(
  ctx: AppContext,
  a: { user: User; chatId: number | undefined; instanceId: number; optionIndex: number; receivedAt: Date },
): Promise<{ outcome: IntakeOutcome; text: string }> {
  return ctx.db.transaction().execute(async (tx) => {
    const li = await loadInstance(tx, a.instanceId);
    const lang = (li?.language ?? ctx.cfg.DEFAULT_LANGUAGE) as Lang;
    if (!li || !li.content || (li.gameType !== "picture_quiz" && li.gameType !== "emoji_puzzle")) return { outcome: "invalid", text: t(lang, "buttonExpired") };
    // The button must come from this question's own group chat (no cross-group answers).
    if (a.chatId !== li.groupChatId) return { outcome: "invalid", text: t(lang, "buttonExpired") };
    const options = (li.content as ContentOf<"emoji_puzzle">).options;
    if (a.optionIndex < 0 || a.optionIndex >= options.length) return { outcome: "invalid", text: t(lang, "buttonExpired") };
    if (li.inst.invalidated_at || !acceptsAnswers(li.inst.state) || a.receivedAt > li.inst.close_at) return { outcome: "late", text: t(lang, "tooLate") };
    const student = await discoverStudent(ctx, tx, li.groupId, a.user, "callback");
    if (!student || !isEligible(student)) return { outcome: "not_eligible", text: t(lang, "notEligible") };
    const sub = await insertSubmission(tx, { instanceId: li.inst.id, groupId: li.groupId, studentId: student.id, stage: 1, kind: "button", optionIndex: a.optionIndex, receivedAt: a.receivedAt });
    if (!sub) return { outcome: "duplicate", text: t(lang, "alreadyAnswered") };
    await confirmDeliveryByEvidence(ctx, tx, li);
    await gradeAndRecord(ctx, tx, li, sub, engineFor(li.gameType).grade(li.content, { optionIndex: a.optionIndex }, { aiGradingEnabled: false }));
    ctx.metrics.inc("answers_total");
    return { outcome: "accepted", text: t(lang, "answerAccepted") };
  });
}

// ---------------------------------------------------------------- private text answers

export interface BotReply {
  text: string;
  html?: boolean;
  buttons?: { text: string; data?: string; url?: string }[][];
}

/**
 * Deep-link entry ("/start a_<instanceId>"): links an already eligible student's private chat to the
 * question. It is not an enrollment step and earns nothing. Membership of unknown users is verified with
 * getChatMember (works when the bot is a group admin).
 */
export async function startAnswerSession(ctx: AppContext, user: User, instanceId: number, receivedAt: Date): Promise<BotReply> {
  const li = await loadInstance(ctx.db, instanceId);
  const lang = (li?.language ?? ctx.cfg.DEFAULT_LANGUAGE) as Lang;
  if (!li || !li.content || (li.gameType !== "find_mistake" && li.gameType !== "guess_word")) return { text: t(lang, "noOpenQuestion") };
  const student = await resolvePrivateStudent(ctx, li.groupId, li.groupChatId, user);
  if (!student) return { text: t(lang, "privateUnknown") };
  await ctx.db.updateTable("telegram_users").set({ private_chat_ready: true, private_started_at: receivedAt }).where("id", "=", user.id).execute();
  if (!isEligible(student)) return { text: t(lang, "notEligible") };
  if (li.inst.invalidated_at || !acceptsAnswers(li.inst.state) || receivedAt > li.inst.close_at) return { text: t(lang, "tooLate") };
  await ctx.db
    .insertInto("answer_sessions")
    .values({ telegram_user_id: user.id, instance_id: li.inst.id, student_id: student.id, started_at: receivedAt })
    .onConflict((oc) => oc.column("telegram_user_id").doUpdateSet({ instance_id: li.inst.id, student_id: student.id, started_at: receivedAt }))
    .execute();
  return questionPrompt(li, lang);
}

function questionPrompt(li: LoadedInstance, lang: Lang): BotReply {
  if (li.gameType === "find_mistake") {
    const c = li.content as ContentOf<"find_mistake">;
    return { text: `${escapeHtml(c.prompt)}\n<pre>${escapeHtml(c.code)}</pre>\n\n${t(lang, "findMistakeAsk")}`, html: true };
  }
  const c = li.content as ContentOf<"guess_word">;
  const shown = c.clues.slice(0, li.inst.current_stage).map((clue, i) => `<b>${t(lang, "clue", { n: i + 1 })}:</b> ${escapeHtml(clue)}`);
  return { text: `${shown.join("\n")}\n\n${t(lang, "guessAsk")}`, html: true };
}

export async function resolvePrivateStudent(ctx: AppContext, groupId: number, groupChatId: number, user: User): Promise<Row<"students"> | null> {
  if (user.is_bot || ctx.cfg.BOT_ADMIN_IDS.includes(user.id)) return null;
  const existing = await getStudentByUser(ctx.db, groupId, user.id);
  if (existing && existing.membership === "member") return existing;
  try {
    const member = await ctx.tg.getChatMember({ chat_id: groupChatId, user_id: user.id });
    if (["member", "administrator", "creator", "restricted"].includes(member.status)) {
      return ctx.db.transaction().execute((tx) => discoverStudent(ctx, tx, groupId, user, "private_start"));
    }
  } catch (err) {
    ctx.log.warn({ groupId, err: (err as Error).message }, "getChatMember failed during private start");
  }
  return existing ?? null;
}

/** Find which question a private text answers: the deep-link session, else the only open text question. */
async function sessionInstance(ctx: AppContext, user: User): Promise<number | null> {
  const s = await ctx.db.selectFrom("answer_sessions").select("instance_id").where("telegram_user_id", "=", user.id).executeTakeFirst();
  if (s) {
    const st = await ctx.db.selectFrom("question_instances").select("state").where("id", "=", s.instance_id).executeTakeFirst();
    if (st && acceptsAnswers(st.state)) return s.instance_id;
  }
  const open = await ctx.db
    .selectFrom("question_instances as qi")
    .innerJoin("students as s", (j) => j.onRef("s.group_id", "=", "qi.group_id").on("s.telegram_user_id", "=", user.id))
    .select("qi.id")
    .where("qi.state", "in", ["open", "uncertain"])
    .where("qi.game_type", "in", ["find_mistake", "guess_word"])
    .execute();
  return open.length === 1 ? open[0]!.id : null;
}

export async function handlePrivateText(ctx: AppContext, user: User, text: string, receivedAt: Date, lang: Lang): Promise<BotReply> {
  const instanceId = await sessionInstance(ctx, user);
  if (!instanceId) return { text: t(lang, "noOpenQuestion") };
  if (text.length > MAX_TEXT_ANSWER) return { text: t(lang, "tooLong") };
  return ctx.db.transaction().execute(async (tx) => {
    const li = await loadInstance(tx, instanceId);
    const qlang = (li?.language ?? lang) as Lang;
    if (!li || !li.content) return { text: t(qlang, "noOpenQuestion") };
    if (li.inst.invalidated_at || !acceptsAnswers(li.inst.state) || receivedAt > li.inst.close_at) return { text: t(qlang, "tooLate") };
    const student = await getStudentByUser(tx, li.groupId, user.id);
    if (!student || !isEligible(student)) return { text: t(qlang, "notEligible") };

    if (li.gameType === "find_mistake") {
      const done = await tx.selectFrom("submissions").select("id").where("instance_id", "=", li.inst.id).where("student_id", "=", student.id).executeTakeFirst();
      if (done) return { text: t(qlang, "alreadyAnswered") };
      await tx
        .insertInto("text_drafts")
        .values({ instance_id: li.inst.id, student_id: student.id, answer_text: text, received_at: receivedAt })
        .onConflict((oc) => oc.columns(["instance_id", "student_id"]).doUpdateSet({ answer_text: text, received_at: receivedAt }))
        .execute();
      return {
        text: `<pre>${escapeHtml(text)}</pre>\n${t(qlang, "confirmDraft")}`,
        html: true,
        buttons: [[{ text: t(qlang, "confirmSend"), data: ctx.callbacks.encode("fc", li.inst.id) }, { text: t(qlang, "confirmEdit"), data: ctx.callbacks.encode("fe", li.inst.id) }]],
      };
    }

    // Guess the word: one guess per clue stage; the stage is the one current when the guess was received.
    const stage = li.inst.current_stage;
    const sub = await insertSubmission(tx, { instanceId: li.inst.id, groupId: li.groupId, studentId: student.id, stage, kind: "text", text, receivedAt });
    if (!sub) return { text: t(qlang, "stageAlreadyAnswered") };
    const settings = await getSettings(ctx, tx, li.groupId);
    await confirmDeliveryByEvidence(ctx, tx, li);
    await gradeAndRecord(ctx, tx, li, sub, engineFor("guess_word").grade(li.content, { text }, { aiGradingEnabled: settings.aiGradingEnabled }));
    ctx.metrics.inc("answers_total");
    return { text: t(qlang, "answerAccepted") };
  });
}

/** Confirm a find-the-mistake draft: this locks the final answer (time of confirmation must beat the deadline). */
export async function confirmDraft(ctx: AppContext, user: User, instanceId: number, receivedAt: Date): Promise<{ text: string; outcome: IntakeOutcome }> {
  return ctx.db.transaction().execute(async (tx) => {
    const li = await loadInstance(tx, instanceId);
    const lang = (li?.language ?? ctx.cfg.DEFAULT_LANGUAGE) as Lang;
    if (!li || !li.content || li.gameType !== "find_mistake") return { outcome: "invalid", text: t(lang, "buttonExpired") };
    if (li.inst.invalidated_at || !acceptsAnswers(li.inst.state) || receivedAt > li.inst.close_at) return { outcome: "late", text: t(lang, "tooLate") };
    const student = await getStudentByUser(tx, li.groupId, user.id);
    if (!student || !isEligible(student)) return { outcome: "not_eligible", text: t(lang, "notEligible") };
    const draft = await tx.selectFrom("text_drafts").selectAll().where("instance_id", "=", li.inst.id).where("student_id", "=", student.id).executeTakeFirst();
    if (!draft) return { outcome: "invalid", text: t(lang, "sendNewDraft") };
    const sub = await insertSubmission(tx, { instanceId: li.inst.id, groupId: li.groupId, studentId: student.id, stage: 1, kind: "text", text: draft.answer_text, receivedAt });
    if (!sub) return { outcome: "duplicate", text: t(lang, "alreadyAnswered") };
    await tx.deleteFrom("text_drafts").where("instance_id", "=", li.inst.id).where("student_id", "=", student.id).execute();
    const settings = await getSettings(ctx, tx, li.groupId);
    await confirmDeliveryByEvidence(ctx, tx, li);
    await gradeAndRecord(ctx, tx, li, sub, engineFor("find_mistake").grade(li.content, { text: draft.answer_text }, { aiGradingEnabled: settings.aiGradingEnabled }));
    ctx.metrics.inc("answers_total");
    return { outcome: "accepted", text: t(lang, "answerAccepted") };
  });
}
