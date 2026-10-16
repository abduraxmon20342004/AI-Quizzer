import type { CallbackQuery, ChatMemberUpdated, Message, Poll, PollAnswer, Update, User } from "node-telegram-bot-api";
import type { AppContext } from "../app/context.js";
import { isBotAdmin } from "../app/context.js";
import { escapeHtml } from "../domain/telegramLimits.js";
import { t, type Lang } from "../i18n/index.js";
import { intArg, intArg0 } from "../telegram/callbackData.js";
import { alertAdmins } from "../services/alerts.js";
import { ensureGroup, getGroupByChat, getSettings } from "../services/groups.js";
import { discoverStudent, markLeft } from "../services/roster.js";
import { confirmDraft, handleAnswerButton, handlePollAnswer, handlePrivateText, pollAnswerForInstance, resolvePrivateStudent, startAnswerSession, type BotReply } from "../services/submissions.js";
import { enqueue } from "../services/outbox.js";
import { handleAdminCallback, handleAdminCommand, handleAdminInput } from "./admin.js";

/** Update types the bot needs. chat_member must be requested explicitly (and needs bot admin rights). */
export const ALLOWED_UPDATES = ["message", "callback_query", "poll", "poll_answer", "my_chat_member", "chat_member"];

/**
 * Dispatches Telegram updates. The receive time is captured first and used for every deadline check.
 * Students never get unsolicited private messages: the bot only replies inside a private chat the student
 * opened, and acknowledges group buttons with callback notifications.
 */
export function createRouter(ctx: AppContext) {
  async function handleUpdate(update: Update): Promise<void> {
    const receivedAt = ctx.clock.now();
    const u = update as Update & {
      message?: Message;
      callback_query?: CallbackQuery;
      poll?: Poll;
      poll_answer?: PollAnswer;
      my_chat_member?: ChatMemberUpdated;
      chat_member?: ChatMemberUpdated;
    };
    ctx.metrics.inc("updates_total");
    if (u.poll_answer) {
      await handlePollAnswer(ctx, { pollId: u.poll_answer.poll_id, user: u.poll_answer.user, optionIds: u.poll_answer.option_ids, receivedAt });
    } else if (u.callback_query) {
      await onCallback(u.callback_query, receivedAt);
    } else if (u.message) {
      if (u.message.chat.type === "private") await onPrivate(u.message, receivedAt);
      else if (u.message.chat.type === "group" || u.message.chat.type === "supergroup") await onGroupMessage(u.message);
    } else if (u.my_chat_member) {
      await onMyChatMember(u.my_chat_member);
    } else if (u.chat_member) {
      await onChatMember(u.chat_member);
    } else if (u.poll) {
      await onPoll(u.poll);
    }
    ctx.metrics.set("last_update_ms", Date.now() - receivedAt.getTime());
  }

  async function onGroupMessage(msg: Message): Promise<void> {
    if (msg.migrate_to_chat_id) {
      // Group upgraded to a supergroup: Telegram assigns a new chat id.
      await ctx.db.updateTable("groups").set({ chat_id: msg.migrate_to_chat_id }).where("chat_id", "=", msg.chat.id).execute();
      return;
    }
    const group = await getGroupByChat(ctx.db, msg.chat.id);
    if (!group || group.status !== "active") return;
    await ctx.db.transaction().execute(async (tx) => {
      for (const m of msg.new_chat_members ?? []) {
        if (m.id !== ctx.bot.id) await discoverStudent(ctx, tx, group.id, m, "new_members");
      }
      if (msg.left_chat_member && msg.left_chat_member.id !== ctx.bot.id) await markLeft(ctx, tx, group.id, msg.left_chat_member.id);
      // Ordinary messages only help discover members (if the bot can see them); they never earn points.
      if (msg.from && !msg.from.is_bot && !msg.new_chat_members && !msg.left_chat_member && !msg.sender_chat) {
        await discoverStudent(ctx, tx, group.id, msg.from, "message");
      }
    });
    const text = msg.text ?? "";
    if (/^\/setup(@\w+)?$/.test(text.trim()) && msg.from && isBotAdmin(ctx, msg.from.id)) {
      const s = await getSettings(ctx, ctx.db, group.id);
      await ctx.db.transaction().execute((tx) =>
        enqueue(tx, {
          groupId: group.id,
          chatId: group.chat_id,
          method: "sendMessage",
          payload: { chat_id: group.chat_id, text: t(s.language as Lang, "setupPrompt"), reply_markup: { inline_keyboard: [[{ text: t(s.language as Lang, "setupButton"), url: `https://t.me/${ctx.bot.username}?start=s_${group.id}` }]] } },
          dedupeKey: `setup-cmd:${group.id}:${msg.message_id}`,
          purpose: "setup_prompt",
        }),
      );
    }
  }

  async function onMyChatMember(upd: ChatMemberUpdated): Promise<void> {
    if (upd.chat.type !== "group" && upd.chat.type !== "supergroup") return;
    const status = upd.new_chat_member.status;
    const present = ["member", "administrator", "creator", "restricted"].includes(status);
    await ctx.db.transaction().execute(async (tx) => {
      const g = await ensureGroup(ctx, tx, { id: upd.chat.id, ...(upd.chat.title ? { title: upd.chat.title } : {}) });
      await tx.updateTable("groups").set({ status: present ? "active" : "left", bot_is_admin: status === "administrator", updated_at: ctx.clock.now() }).where("id", "=", g.id).execute();
      if (present && upd.old_chat_member.status !== status) {
        await alertAdmins(ctx, tx, {
          key: `group:${g.id}:${status}:${upd.date}`,
          groupId: g.id,
          text:
            status === "administrator"
              ? "Bot guruhda admin qilindi ✅ Endi a'zolar qo'shilishi/chiqishini ko'radi. Sozlash: /admin"
              : "Bot guruhga qo'shildi. A'zolarni aniqlash va o'yinlarni to'liq yuritish uchun botni guruh admini qiling. Sozlash: /admin",
        });
      }
    });
    if (present) {
      try {
        const n = await ctx.tg.getChatMemberCount({ chat_id: upd.chat.id });
        await ctx.db.updateTable("groups").set({ member_count: n, member_count_at: ctx.clock.now() }).where("chat_id", "=", upd.chat.id).execute();
      } catch {
        /* optional */
      }
    }
  }

  async function onChatMember(upd: ChatMemberUpdated): Promise<void> {
    const group = await getGroupByChat(ctx.db, upd.chat.id);
    if (!group) return;
    const st = upd.new_chat_member.status;
    const user = upd.new_chat_member.user;
    const isMember = ["member", "administrator", "creator"].includes(st) || (st === "restricted" && (upd.new_chat_member as { is_member?: boolean }).is_member);
    await ctx.db.transaction().execute(async (tx) => {
      if (isMember) await discoverStudent(ctx, tx, group.id, user, "chat_member");
      else await markLeft(ctx, tx, group.id, user.id);
    });
  }

  /** A poll update for an unknown poll can recover a question whose send was uncertain (same question text). */
  async function onPoll(poll: Poll): Promise<void> {
    const known = await ctx.db.selectFrom("question_instances").select("id").where("poll_id", "=", poll.id).executeTakeFirst();
    if (known) return;
    const candidates = await ctx.db
      .selectFrom("question_instances as qi")
      .innerJoin("outbox as o", (j) => j.on("o.purpose", "=", "question").onRef("o.ref_id", "=", "qi.id"))
      .select(["qi.id", "o.payload", "o.id as outbox_id"])
      .where("qi.state", "in", ["uncertain", "closed"])
      .where("qi.poll_id", "is", null)
      .where("o.status", "=", "uncertain")
      .execute();
    const match = candidates.filter((c) => (c.payload as { question?: string }).question === poll.question);
    if (match.length !== 1) return;
    const m = match[0]!;
    await ctx.db.transaction().execute(async (tx) => {
      await tx.updateTable("outbox").set({ status: "sent", last_error: "delivery confirmed by poll update" }).where("id", "=", m.outbox_id).where("status", "=", "uncertain").execute();
      const inst = await tx.selectFrom("question_instances").selectAll().where("id", "=", m.id).forUpdate().executeTakeFirstOrThrow();
      await tx
        .updateTable("question_instances")
        .set({ poll_id: poll.id, delivery_confirmed: true, ...(inst.state === "uncertain" ? { state: "open" as const, opened_at: inst.publish_at } : {}), state_reason: "delivery confirmed by poll update" })
        .where("id", "=", inst.id)
        .execute();
      const orphans = await tx.selectFrom("orphan_poll_answers").selectAll().where("poll_id", "=", poll.id).execute();
      for (const o of orphans) {
        const user = await tx.selectFrom("telegram_users").selectAll().where("id", "=", o.user_id).executeTakeFirst();
        if (user) await pollAnswerForInstance(ctx, tx, inst.id, { id: user.id, is_bot: user.is_bot, first_name: user.first_name }, o.option_ids, o.received_at);
      }
      await tx.deleteFrom("orphan_poll_answers").where("poll_id", "=", poll.id).execute();
    });
  }

  async function answerCb(id: string, text?: string): Promise<void> {
    try {
      await ctx.tg.answerCallbackQuery({ callback_query_id: id, ...(text ? { text: text.slice(0, 200) } : {}) });
    } catch (err) {
      ctx.log.debug({ err: (err as Error).message }, "answerCallbackQuery failed");
    }
  }

  async function onCallback(cq: CallbackQuery, receivedAt: Date): Promise<void> {
    const decoded = ctx.callbacks.decode(cq.data);
    if (!decoded) {
      await answerCb(cq.id, t(ctx.cfg.DEFAULT_LANGUAGE, "buttonExpired"));
      return;
    }
    const chatId = cq.message?.chat.id;
    const messageId = cq.message?.message_id;
    if (decoded.kind === "a") {
      const instanceId = intArg(decoded.args[0]);
      const option = intArg0(decoded.args[1]);
      if (!instanceId || option === null) return answerCb(cq.id, t(ctx.cfg.DEFAULT_LANGUAGE, "buttonExpired"));
      const res = await handleAnswerButton(ctx, { user: cq.from, chatId, instanceId, optionIndex: option, receivedAt });
      // Private notification only; the shared group keyboard is never changed per student.
      return answerCb(cq.id, res.text);
    }
    if (decoded.kind === "fc" || decoded.kind === "fe") {
      const instanceId = intArg(decoded.args[0]);
      if (!instanceId || cq.message?.chat.type !== "private") return answerCb(cq.id);
      if (decoded.kind === "fe") {
        await answerCb(cq.id);
        await reply(cq.from.id, { text: t(await langFor(cq.from), "sendNewDraft") });
        return;
      }
      const res = await confirmDraft(ctx, cq.from, instanceId, receivedAt);
      await answerCb(cq.id, res.text);
      if (chatId && messageId && res.outcome === "accepted") {
        try {
          await ctx.tg.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
        } catch {
          /* cosmetic */
        }
        await reply(cq.from.id, { text: res.text });
      }
      return;
    }
    if (decoded.kind === "m") {
      if (!chatId || !messageId || cq.message?.chat.type !== "private") return answerCb(cq.id);
      const [action, ...args] = decoded.args;
      const note = await handleAdminCallback(ctx, { user: cq.from, chatId, messageId, action: action ?? "home", args });
      return answerCb(cq.id, note);
    }
    await answerCb(cq.id);
  }

  async function langFor(user: User): Promise<Lang> {
    const row = await ctx.db
      .selectFrom("students as s")
      .innerJoin("group_settings as gs", "gs.group_id", "s.group_id")
      .select("gs.settings")
      .where("s.telegram_user_id", "=", user.id)
      .executeTakeFirst();
    const lang = (row?.settings as { language?: string } | undefined)?.language;
    return lang === "ru" || lang === "en" || lang === "uz" ? lang : ctx.cfg.DEFAULT_LANGUAGE;
  }

  async function reply(chatId: number, r: BotReply): Promise<void> {
    await ctx.tg.sendMessage({
      chat_id: chatId,
      text: r.text,
      ...(r.html ? { parse_mode: "HTML" } : {}),
      ...(r.buttons ? { reply_markup: { inline_keyboard: r.buttons.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data! }))) } } : {}),
    });
  }

  async function onPrivate(msg: Message, receivedAt: Date): Promise<void> {
    const user = msg.from;
    if (!user || user.is_bot) return;
    const text = msg.text ?? "";
    const admin = isBotAdmin(ctx, user.id);
    if (admin) {
      if (/^\/(start|admin|menu)\b/.test(text) || text === "/cancel") return handleAdminCommand(ctx, msg, user);
      if (await handleAdminInput(ctx, msg, user)) return;
      return handleAdminCommand(ctx, msg, user);
    }

    const start = text.match(/^\/start(?:\s+([A-Za-z0-9_-]{1,64}))?$/);
    if (start) {
      const payload = start[1] ?? "";
      const lang = await langFor(user);
      if (payload.startsWith("a_")) {
        const instanceId = intArg(payload.slice(2));
        return reply(user.id, instanceId ? await startAnswerSession(ctx, user, instanceId, receivedAt) : { text: t(lang, "noOpenQuestion") });
      }
      let groupIds: { id: number; chat_id: number }[] = [];
      if (payload.startsWith("s_")) {
        const gid = intArg(payload.slice(2));
        const g = gid ? await ctx.db.selectFrom("groups").select(["id", "chat_id"]).where("id", "=", gid).executeTakeFirst() : undefined;
        if (g) groupIds = [g];
      } else {
        groupIds = await ctx.db.selectFrom("students as s").innerJoin("groups as g", "g.id", "s.group_id").select(["g.id", "g.chat_id"]).where("s.telegram_user_id", "=", user.id).execute();
      }
      let found = false;
      for (const g of groupIds) {
        const st = await resolvePrivateStudent(ctx, g.id, g.chat_id, user);
        if (st) found = true;
      }
      if (!found) return reply(user.id, { text: t(lang, "privateUnknown") });
      // Technical setup only: no enrollment, no points.
      await ctx.db.updateTable("telegram_users").set({ private_chat_ready: true, private_started_at: receivedAt }).where("id", "=", user.id).execute();
      return reply(user.id, { text: t(await langFor(user), "privateReady") });
    }
    if (!text || text.startsWith("/")) {
      return reply(user.id, { text: t(await langFor(user), "noOpenQuestion") });
    }
    const r = await handlePrivateText(ctx, user, text, receivedAt, await langFor(user));
    return reply(user.id, r);
  }

  return { handleUpdate };
}

export function describeUser(u: User): string {
  return escapeHtml([u.first_name, u.last_name].filter(Boolean).join(" "));
}
