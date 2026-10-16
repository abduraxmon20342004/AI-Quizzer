import { sql } from "kysely";
import type { Message, User } from "node-telegram-bot-api";
import type { AppContext } from "../app/context.js";
import { isBotAdmin } from "../app/context.js";
import { spentToday } from "../ai/budget.js";
import { parseContent } from "../domain/content.js";
import { GAME_TYPES, type GameType } from "../domain/gameTypes.js";
import { dayName, validateSettings } from "../domain/schedule.js";
import type { GroupSettings } from "../domain/settings.js";
import { TG, escapeHtml } from "../domain/telegramLimits.js";
import { addDays, localDateOf } from "../domain/time.js";
import { engineFor } from "../games/engines.js";
import { gameName } from "../i18n/index.js";
import { intArg, intArg0 } from "../telegram/callbackData.js";
import { enqueue, resolveUncertain } from "../services/outbox.js";
import { createBatch, pendingReviewCount } from "../services/generation.js";
import { adminCorrectVerdict } from "../services/grading.js";
import { getSettings, saveSettings } from "../services/groups.js";
import { addPictureAsset, addTelegramDocument, addTextMaterial, deleteMaterial } from "../services/materials.js";
import { finishAndReport, overrideDayType, reconcileGroup, stopToday } from "../services/planner.js";
import { approveVersion, bankStats, rejectVersion } from "../services/questionBank.js";
import { importRoster, linkRoster, listStudents, rosterCompleteness, setStudentStatus, unlinkRoster } from "../services/roster.js";
import { splitSourceExtra } from "../domain/rules.js";
import { fieldByKey, SETTING_FIELDS, TOGGLES } from "./settingsFields.js";

/**
 * Admin panel inside the private chat. Only BOT_ADMIN_IDS may use it - checked on every message and every
 * callback (being a Telegram group admin grants nothing). Every action names its target group and replies
 * with a short confirmation of what was saved.
 */

type Btn = { text: string; data?: string; url?: string };
type Kb = Btn[][];
interface Screen {
  text: string;
  kb: Kb;
}
type Pending =
  | { kind: "setting"; key: string }
  | { kind: "roster_import" }
  | { kind: "material_text" }
  | { kind: "material_file" }
  | { kind: "picture" }
  | { kind: "verdict_reason"; submissionId: number; verdict: "correct" | "incorrect" }
  | { kind: "reject_reason"; versionId: number };

const PAGE = 8;

function cb(ctx: AppContext, action: string, ...args: (string | number)[]): string {
  return ctx.callbacks.encode("m", action, ...args);
}

function back(ctx: AppContext, to = "home"): Btn[] {
  return [{ text: "⬅️ Orqaga", data: cb(ctx, to) }];
}

async function session(ctx: AppContext, adminId: number) {
  const s = await ctx.db.selectFrom("admin_sessions").selectAll().where("admin_telegram_id", "=", adminId).executeTakeFirst();
  if (s) return s;
  return ctx.db
    .insertInto("admin_sessions")
    .values({ admin_telegram_id: adminId })
    .onConflict((oc) => oc.column("admin_telegram_id").doUpdateSet({ updated_at: ctx.clock.now() }))
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function setPending(ctx: AppContext, adminId: number, pending: Pending | null) {
  await session(ctx, adminId);
  await ctx.db
    .updateTable("admin_sessions")
    .set({ pending: pending ? JSON.stringify(pending) : null, updated_at: ctx.clock.now() })
    .where("admin_telegram_id", "=", adminId)
    .execute();
}

async function currentGroup(ctx: AppContext, adminId: number) {
  const s = await session(ctx, adminId);
  if (s.group_id) {
    const g = await ctx.db.selectFrom("groups").selectAll().where("id", "=", s.group_id).executeTakeFirst();
    if (g) return g;
  }
  const groups = await ctx.db.selectFrom("groups").selectAll().where("status", "=", "active").orderBy("id").execute();
  if (groups.length === 1) {
    await ctx.db.updateTable("admin_sessions").set({ group_id: groups[0]!.id }).where("admin_telegram_id", "=", adminId).execute();
    return groups[0]!;
  }
  return null;
}

async function show(ctx: AppContext, chatId: number, screen: Screen, editMessageId?: number) {
  const reply_markup = { inline_keyboard: screen.kb.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data! }))) };
  const text = screen.text.slice(0, TG.MESSAGE_MAX);
  try {
    if (editMessageId) {
      await ctx.tg.editMessageText({ chat_id: chatId, message_id: editMessageId, text, parse_mode: "HTML", reply_markup, link_preview_options: { is_disabled: true } });
      return;
    }
  } catch {
    /* message too old or unchanged: fall back to a new message */
  }
  await ctx.tg.sendMessage({ chat_id: chatId, text, parse_mode: "HTML", reply_markup, link_preview_options: { is_disabled: true } });
}

function saved(groupTitle: string, what: string): string {
  return `✅ Saqlandi — <b>${escapeHtml(groupTitle)}</b>: ${what}`;
}

// ---------------------------------------------------------------- screens

async function homeScreen(ctx: AppContext, adminId: number, note = ""): Promise<Screen> {
  const g = await currentGroup(ctx, adminId);
  let status = "Guruh tanlanmagan. «👥 Guruhlar» dan tanlang.";
  if (g) {
    const s = await getSettings(ctx, ctx.db, g.id);
    const today = localDateOf(ctx.clock.now(), s.timezone);
    const plan = await ctx.db.selectFrom("day_plans").selectAll().where("group_id", "=", g.id).where("local_date", "=", today).executeTakeFirst();
    const counts = plan
      ? await ctx.db
          .selectFrom("question_instances")
          .select([sql<number>`count(*) filter (where state not in ('canceled'))::int`.as("total"), sql<number>`count(*) filter (where opened_at is not null)::int`.as("sent")])
          .where("day_plan_id", "=", plan.id)
          .executeTakeFirstOrThrow()
      : { total: 0, sent: 0 };
    const type = plan?.game_type ? gameName("uz", plan.game_type as GameType) : "o'yin yo'q";
    status =
      `Guruh: <b>${escapeHtml(g.title)}</b>\n` +
      `Bugun (${today}): ${type} · ${plan?.status ?? "reja yo'q"} · ${counts.sent}/${counts.total} savol\n` +
      `Vaqt: ${s.startTime}–${s.endTime} · Tasdiq kutmoqda: ${await pendingReviewCount(ctx.db, g.id)}`;
  }
  return {
    text: `${note ? note + "\n\n" : ""}🎛 <b>Boshqaruv paneli</b>\n${status}`,
    kb: [
      [{ text: "👥 Guruhlar", data: cb(ctx, "groups") }, { text: "🧑‍🎓 O'quvchilar", data: cb(ctx, "st") }],
      [{ text: "📚 Materiallar", data: cb(ctx, "mat") }, { text: "❓ Savollar", data: cb(ctx, "q") }],
      [{ text: "🗓 Jadval", data: cb(ctx, "sch") }, { text: "🎮 O'yin turlari", data: cb(ctx, "gt") }],
      [{ text: "🏅 Ballar", data: cb(ctx, "pts") }, { text: "📊 Hisobotlar", data: cb(ctx, "rep") }],
      [{ text: "🤖 AI sozlamalari", data: cb(ctx, "ai") }],
      [{ text: "⛔ Bugungi o'yinlarni to'xtatish", data: cb(ctx, "stop") }],
    ],
  };
}

async function groupsScreen(ctx: AppContext): Promise<Screen> {
  const groups = await ctx.db.selectFrom("groups").selectAll().orderBy("id").execute();
  const lines = groups.map((g) => `• ${escapeHtml(g.title || String(g.chat_id))} — ${g.status}${g.bot_is_admin ? "" : " (bot admin emas!)"}`);
  return {
    text: `👥 <b>Guruhlar</b>\n${lines.join("\n") || "Bot hali birorta guruhga qo'shilmagan. Botni guruhga qo'shing va admin qiling."}\n\nBoshqarish uchun guruhni tanlang.`,
    kb: [...groups.filter((g) => g.status === "active").map((g) => [{ text: g.title || String(g.chat_id), data: cb(ctx, "gsel", g.id) }]), back(ctx)],
  };
}

function settingsLines(s: GroupSettings, keys: string[]): string {
  return keys
    .map((k) => fieldByKey(k)!)
    .map((f) => `• ${f.label}: <b>${escapeHtml(f.show(s))}</b>`)
    .join("\n");
}

function fieldButtons(ctx: AppContext, keys: string[]): Kb {
  const rows: Kb = [];
  for (let i = 0; i < keys.length; i += 2) {
    rows.push(keys.slice(i, i + 2).map((k) => ({ text: `✏️ ${fieldByKey(k)!.label}`.slice(0, 40), data: cb(ctx, "se", k) })));
  }
  return rows;
}

async function scheduleScreen(ctx: AppContext, groupId: number): Promise<Screen> {
  const s = await getSettings(ctx, ctx.db, groupId);
  const days = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ text: `${s.activeDays.includes(d) ? "✅" : "▫️"} ${dayName(d).slice(0, 2)}`, data: cb(ctx, "sdt", d) }));
  const problems = validateSettings(s);
  const keys = ["st", "et", "qn", "as", "sp", "tz", "wd", "wt", "dm"];
  return {
    text: `🗓 <b>Jadval</b>\n${settingsLines(s, keys)}\n• Faol kunlar: ${s.activeDays.map((d) => dayName(d)).join(", ") || "—"}${problems.length ? `\n\n⚠️ ${problems.map(escapeHtml).join("\n⚠️ ")}` : ""}`,
    kb: [days.slice(0, 4), days.slice(4), ...fieldButtons(ctx, keys), back(ctx)],
  };
}

async function pointsScreen(ctx: AppContext, groupId: number): Promise<Screen> {
  const s = await getSettings(ctx, ctx.db, groupId);
  const keys = ["pe", "pm", "ph", "pt", "po", "pg", "se", "sb"];
  return {
    text: `🏅 <b>Ballar</b> (faqat keyingi savollarga ta'sir qiladi)\n${settingsLines(s, keys)}\n• Seriya bonuslari: <b>${s.streak.enabled ? "yoqilgan" : "o'chirilgan"}</b>\nNoto'g'ri javob uchun ball ayirilmaydi; tezlik uchun bonus yo'q.`,
    kb: [...fieldButtons(ctx, keys), [{ text: `${s.streak.enabled ? "🔕 Seriyani o'chirish" : "🔔 Seriyani yoqish"}`, data: cb(ctx, "tg", "sk") }], back(ctx)],
  };
}

async function aiScreen(ctx: AppContext, groupId: number): Promise<Screen> {
  const s = await getSettings(ctx, ctx.db, groupId);
  const spent = await spentToday(ctx.db, groupId, localDateOf(ctx.clock.now(), s.timezone));
  const keys = ["bu", "sr", "rr", "bd", "tp", "lv", "ln"];
  const toggles = TOGGLES.filter((t) => t.key !== "sk" && t.key !== "si");
  return {
    text:
      `🤖 <b>AI sozlamalari</b>\n` +
      `Provayder: ${ctx.ai.name}${ctx.ai.isMock ? " (DEMO)" : ""}\nModellar: yaratish ${ctx.cfg.AI_GENERATION_MODEL}, tekshirish ${ctx.cfg.AI_REVIEW_MODEL}, baholash ${ctx.cfg.AI_GRADING_MODEL}\n` +
      `Bugungi xarajat: $${spent.toFixed(3)} / $${s.aiDailyBudgetUsd}\n` +
      `${settingsLines(s, keys)}\n` +
      toggles.map((t) => `• ${t.label}: <b>${t.get(s) ? "ha" : "yo'q"}</b>`).join("\n"),
    kb: [...fieldButtons(ctx, keys), ...toggles.map((t) => [{ text: `${t.get(s) ? "✅" : "▫️"} ${t.label}`.slice(0, 60), data: cb(ctx, "tg", t.key) }]), back(ctx)],
  };
}

async function studentsScreen(ctx: AppContext, groupId: number): Promise<Screen> {
  const c = await rosterCompleteness(ctx.db, groupId);
  const text =
    `🧑‍🎓 <b>O'quvchilar</b>\n` +
    `Telegram a'zolari (bot bilan): ${c.telegramMemberCount ?? "noma'lum"}\n` +
    `Sinf ro'yxati: ${c.rosterTotal} ta, bog'langan ${c.rosterLinked}, bog'lanmagan ${c.rosterUnlinked}\n` +
    `Aniqlangan, ro'yxatda yo'q: ${c.discoveredNotInRoster}\n` +
    `Faol: ${c.eligible} · bloklangan: ${c.blocked} · chiqib ketgan: ${c.left} · arxiv: ${c.archived}\n` +
    `Shaxsiy chatni boshlaganlar: ${c.privateReady}\n\n` +
    `ℹ️ Telegram guruhdagi barcha a'zolar ro'yxatini bermaydi. Bot o'quvchini u qo'shilganda, javob berganda yoki botni ishga tushirganda aniqlaydi. ` +
    `Aniqlanmagan o'quvchi hisobotda "0 ball" bilan ko'rsatilmaydi.`;
  return {
    text,
    kb: [
      [{ text: "📋 O'quvchilar ro'yxati", data: cb(ctx, "stl", 0) }, { text: "📝 Sinf ro'yxatini kiritish", data: cb(ctx, "sim") }],
      [{ text: "🔗 Bog'lanmagan ismlar", data: cb(ctx, "rl", 0) }, { text: "📣 Shaxsiy chat tugmasi", data: cb(ctx, "setup") }],
      back(ctx),
    ],
  };
}

async function studentListScreen(ctx: AppContext, groupId: number, page: number): Promise<Screen> {
  const list = await listStudents(ctx.db, groupId, { offset: page * PAGE, limit: PAGE + 1, includeArchived: true });
  const icon = (st: string, m: string) => (st === "blocked" ? "🚫" : st === "archived" ? "🗄" : m === "left" ? "🚪" : "✅");
  const rows: Kb = list.slice(0, PAGE).map((s) => [{ text: `${icon(s.status, s.membership)} ${s.name}${s.rosterName ? "" : " (ro'yxatda yo'q)"}`.slice(0, 60), data: cb(ctx, "sd", s.id) }]);
  const nav: Btn[] = [];
  if (page > 0) nav.push({ text: "◀️", data: cb(ctx, "stl", page - 1) });
  if (list.length > PAGE) nav.push({ text: "▶️", data: cb(ctx, "stl", page + 1) });
  return { text: `📋 <b>O'quvchilar</b> (sahifa ${page + 1})`, kb: [...rows, ...(nav.length ? [nav] : []), back(ctx, "st")] };
}

async function studentDetail(ctx: AppContext, groupId: number, studentId: number): Promise<Screen | null> {
  const list = await listStudents(ctx.db, groupId, { includeArchived: true });
  const s = list.find((x) => x.id === studentId);
  if (!s) return null;
  const roster = await ctx.db.selectFrom("roster_entries").select("id").where("student_id", "=", studentId).executeTakeFirst();
  return {
    text:
      `👤 <b>${escapeHtml(s.name)}</b>\nTelegram: ${escapeHtml(s.telegramName)}${s.username ? ` (@${escapeHtml(s.username)})` : ""} · id ${s.telegramUserId}\n` +
      `Holat: ${s.status}${s.membership === "left" ? " · guruhdan chiqqan" : ""}\nShaxsiy chat: ${s.privateReady ? "boshlangan" : "boshlanmagan"}\n` +
      `Sinf ro'yxati: ${s.rosterName ? escapeHtml(s.rosterName) : "bog'lanmagan"}`,
    kb: [
      [{ text: "✅ Ruxsat", data: cb(ctx, "ss", studentId, "e") }, { text: "🚫 Bloklash", data: cb(ctx, "ss", studentId, "b") }, { text: "🗄 Arxiv", data: cb(ctx, "ss", studentId, "a") }],
      roster ? [{ text: "✂️ Ro'yxatdan uzish", data: cb(ctx, "sul", roster.id, studentId) }] : [{ text: "🔗 Ro'yxatdagi ismga bog'lash", data: cb(ctx, "slk", studentId, 0) }],
      back(ctx, "st"),
    ],
  };
}

async function materialsScreen(ctx: AppContext, groupId: number): Promise<Screen> {
  const s = await getSettings(ctx, ctx.db, groupId);
  const mats = await ctx.db
    .selectFrom("materials")
    .select(["id", "title", "status", "active", "kind", "error"])
    .where("group_id", "=", groupId)
    .where("status", "!=", "deleted")
    .orderBy("id", "desc")
    .limit(10)
    .execute();
  const icon = (m: (typeof mats)[number]) => (m.status === "ready" ? (m.active ? "🟢" : "⚪️") : m.status === "failed" ? "❌" : "⏳");
  return {
    text:
      `📚 <b>Materiallar</b> (faqat shu guruh uchun)\nMavzu: <b>${escapeHtml(s.topic || "—")}</b> · Daraja: <b>${escapeHtml(s.level || "—")}</b>\n` +
      (mats.map((m) => `${icon(m)} #${m.id} ${escapeHtml(m.title)} (${m.kind})${m.error ? ` — ${escapeHtml(m.error.slice(0, 80))}` : ""}`).join("\n") || "Hali material yo'q.") +
      `\n🟢 faol to'plamda · ⚪️ faol emas`,
    kb: [
      [{ text: "➕ Matn qo'shish", data: cb(ctx, "mtx") }, { text: "📎 Fayl yuklash", data: cb(ctx, "mfl") }],
      [{ text: "🏷 Mavzu", data: cb(ctx, "se", "tp") }, { text: "🎓 Daraja", data: cb(ctx, "se", "lv") }],
      ...mats.map((m) => [
        { text: `${m.active ? "⚪️ O'chirish" : "🟢 Faollash"} #${m.id}`, data: cb(ctx, "mta", m.id) },
        { text: `🗑 #${m.id}`, data: cb(ctx, "mdl", m.id) },
      ]),
      back(ctx),
    ],
  };
}

async function questionsScreen(ctx: AppContext, groupId: number): Promise<Screen> {
  const stats = await bankStats(ctx.db, groupId);
  const lines = GAME_TYPES.map((t) => {
    const st = stats.find((x) => x.type === t);
    return `• ${gameName("uz", t)}: tayyor ${st?.approvedFree ?? 0}, tasdiq kutmoqda ${st?.awaitingReview ?? 0}`;
  });
  const assets = await ctx.db.selectFrom("picture_assets").select(sql<number>`count(*) filter (where status = 'approved')::int`.as("n")).where("group_id", "=", groupId).executeTakeFirstOrThrow();
  return {
    text: `❓ <b>Savollar banki</b>\n${lines.join("\n")}\nTasdiqlangan rasmlar: ${assets.n}`,
    kb: [
      [{ text: "✨ Savol yaratish", data: cb(ctx, "qg") }, { text: `🕒 Tasdiqlash (${await pendingReviewCount(ctx.db, groupId)})`, data: cb(ctx, "qr", 0) }],
      [{ text: "🖼 Rasmlar", data: cb(ctx, "qp") }],
      back(ctx),
    ],
  };
}

async function reviewScreen(ctx: AppContext, groupId: number, offset: number): Promise<Screen> {
  const v = await ctx.db
    .selectFrom("question_versions as v")
    .innerJoin("questions as q", (j) => j.onRef("q.current_version_id", "=", "v.id"))
    .selectAll("v")
    .where("v.group_id", "=", groupId)
    .where("v.review_status", "=", "validated")
    .orderBy("v.id")
    .offset(offset)
    .limit(1)
    .executeTakeFirst();
  if (!v) return { text: "🕒 Tasdiqlashni kutayotgan savol yo'q.", kb: [back(ctx, "q")] };
  const gt = v.game_type as GameType;
  const content = parseContent(gt, v.content);
  const review = (v.ai_review ?? {}) as { problems?: string[] };
  const origin = v.origin === "source" ? "📗 Darsdan" : "🌐 Qo'shimcha (darsdan tashqari — faktni tekshiring!)";
  const refs = (v.source_refs as { ref: string }[]).map((r) => r.ref).join(", ");
  const text =
    `🕒 <b>Tasdiqlash</b> · #${v.id} · ${gameName("uz", gt)} · ${v.difficulty}\n${origin}\n\n` +
    `<pre>${escapeHtml(JSON.stringify(content, null, 1)).slice(0, 2500)}</pre>\n` +
    `✅ Javob: <b>${escapeHtml(engineFor(gt).answerSummary(content, v.language as "uz"))}</b>\n` +
    (v.origin === "source" ? `📎 Manba: ${escapeHtml(refs)}\n«${escapeHtml(v.source_excerpt.slice(0, 400))}»\n` : "") +
    (review.problems?.length ? `⚠️ AI izohi: ${escapeHtml(review.problems.join("; "))}\n` : "✔️ AI tekshiruvidan o'tgan\n");
  return {
    text,
    kb: [
      [{ text: "✅ Tasdiqlash", data: cb(ctx, "qa", v.id, offset) }, { text: "❌ Rad etish", data: cb(ctx, "qx", v.id) }],
      [{ text: "⏭ Keyingisi", data: cb(ctx, "qr", offset + 1) }],
      back(ctx, "q"),
    ],
  };
}

async function gameTypesScreen(ctx: AppContext, groupId: number): Promise<Screen> {
  const s = await getSettings(ctx, ctx.db, groupId);
  const today = localDateOf(ctx.clock.now(), s.timezone);
  const plans = await ctx.db.selectFrom("day_plans").select(["local_date", "game_type", "frozen_at", "status"]).where("group_id", "=", groupId).where("local_date", "in", [today, addDays(today, 1)]).execute();
  const planLine = (d: string, label: string) => {
    const p = plans.find((x) => x.local_date === d);
    return `${label} (${d}): ${p?.game_type ? gameName("uz", p.game_type as GameType) : "o'yin yo'q"}${p?.frozen_at ? " 🔒 (muzlatilgan)" : ""}`;
  };
  const lines = [1, 2, 3, 4, 5, 6, 7].map((d) => {
    const g = s.weekdayGame[String(d) as "1"];
    return `• ${dayName(d)}: ${s.activeDays.includes(d) && g ? gameName("uz", g) : g ? `${gameName("uz", g)} (kun faol emas)` : "o'yin yo'q (faqat hisobot)"}`;
  });
  return {
    text: `🎮 <b>O'yin turlari</b> — har kuni bitta tur\n${lines.join("\n")}\n\n${planLine(today, "Bugun")}\n${planLine(addDays(today, 1), "Ertaga")}\n\nBirinchi savol yuborilgach, kun turi muzlatiladi; o'zgarishlar keyingi kunlarga tegishli.`,
    kb: [
      ...[1, 2, 3, 4, 5, 6, 7].map((d) => [{ text: `✏️ ${dayName(d)}`, data: cb(ctx, "gtd", d) }]),
      [{ text: "📅 Bugungi turni o'zgartirish", data: cb(ctx, "gto", 0) }, { text: "📅 Ertangi tur", data: cb(ctx, "gto", 1) }],
      back(ctx),
    ],
  };
}

function typeChoice(ctx: AppContext, action: string, arg: number): Kb {
  return [
    ...GAME_TYPES.map((t, i) => [{ text: gameName("uz", t), data: cb(ctx, action, arg, i) }]),
    [{ text: "🚫 O'yin yo'q", data: cb(ctx, action, arg, 9) }],
    back(ctx, "gt"),
  ];
}

async function reportsScreen(ctx: AppContext, groupId: number): Promise<Screen> {
  const review = await ctx.db.selectFrom("submissions").select(sql<number>`count(*)::int`.as("n")).where("group_id", "=", groupId).where("verdict", "=", "needs_review").executeTakeFirstOrThrow();
  const uncertain = await ctx.db.selectFrom("outbox").select(sql<number>`count(*)::int`.as("n")).where("group_id", "=", groupId).where("status", "=", "uncertain").executeTakeFirstOrThrow();
  const s = await getSettings(ctx, ctx.db, groupId);
  return {
    text:
      `📊 <b>Hisobotlar</b>\nKunlik hisobot: ${s.endTime} da (bir kunda faqat bitta).\nHaftalik: ${dayName(s.weeklyReport.day)} ${s.weeklyReport.time}.\n` +
      `Ko'rib chiqish kutmoqda: ${review.n} · Noaniq yuborishlar: ${uncertain.n}\nNofaol bo'lim: ${s.showInactiveSection ? "ko'rsatiladi" : "yashirin"}`,
    kb: [
      [{ text: "🏁 Yakunlash va hozir hisobot", data: cb(ctx, "fin") }],
      [{ text: `⚖️ Ko'rib chiqish (${review.n})`, data: cb(ctx, "rv", 0) }, { text: "✏️ Javobni tuzatish", data: cb(ctx, "rc", 0) }],
      [{ text: `⚠️ Noaniq yuborishlar (${uncertain.n})`, data: cb(ctx, "unc") }],
      [{ text: `${s.showInactiveSection ? "🙈 Nofaol bo'limni yashirish" : "👀 Nofaol bo'limni ko'rsatish"}`, data: cb(ctx, "tg", "si") }],
      back(ctx),
    ],
  };
}

async function submissionScreen(ctx: AppContext, groupId: number, mode: "rv" | "rc", offset: number): Promise<Screen> {
  let q = ctx.db
    .selectFrom("submissions as s")
    .innerJoin("question_instances as qi", "qi.id", "s.instance_id")
    .innerJoin("question_versions as v", "v.id", "qi.question_version_id")
    .select(["s.id", "s.verdict", "s.answer_text", "s.option_index", "s.grading_reason", "s.student_id", "s.received_at", "qi.game_type", "v.content", "v.language"])
    .where("s.group_id", "=", groupId)
    .orderBy("s.id", "desc")
    .offset(offset)
    .limit(1);
  q = mode === "rv" ? q.where("s.verdict", "=", "needs_review") : q.where("s.kind", "=", "text").where("s.received_at", ">", new Date(ctx.clock.now().getTime() - 7 * 86_400_000));
  const sub = await q.executeTakeFirst();
  if (!sub) return { text: mode === "rv" ? "⚖️ Ko'rib chiqiladigan javob yo'q." : "So'nggi 7 kunda matnli javob yo'q.", kb: [back(ctx, "rep")] };
  const gt = sub.game_type as GameType;
  const content = parseContent(gt, sub.content);
  const name = (await listStudents(ctx.db, groupId, { includeArchived: true })).find((x) => x.id === sub.student_id)?.name ?? `#${sub.student_id}`;
  return {
    text:
      `⚖️ <b>Javob #${sub.id}</b> · ${gameName("uz", gt)} · ${escapeHtml(name)}\nHolat: <b>${sub.verdict}</b>${sub.grading_reason ? ` — ${escapeHtml(sub.grading_reason)}` : ""}\n` +
      `To'g'ri javob: <b>${escapeHtml(engineFor(gt).answerSummary(content, sub.language as "uz").slice(0, 500))}</b>\n` +
      `O'quvchi javobi:\n<pre>${escapeHtml((sub.answer_text ?? String(sub.option_index)).slice(0, 1500))}</pre>\nO'zgartirish uchun sabab yozish shart.`,
    kb: [
      [{ text: "✅ To'g'ri", data: cb(ctx, "rvv", sub.id, "c") }, { text: "❌ Noto'g'ri", data: cb(ctx, "rvv", sub.id, "i") }],
      [{ text: "⏭ Keyingisi", data: cb(ctx, mode, offset + 1) }],
      back(ctx, "rep"),
    ],
  };
}

async function uncertainScreen(ctx: AppContext, groupId: number): Promise<Screen> {
  const rows = await ctx.db.selectFrom("outbox").select(["id", "purpose", "created_at", "last_error"]).where("group_id", "=", groupId).where("status", "=", "uncertain").orderBy("id").limit(5).execute();
  if (!rows.length) return { text: "⚠️ Noaniq yuborishlar yo'q.", kb: [back(ctx, "rep")] };
  return {
    text:
      `⚠️ <b>Noaniq yuborishlar</b>\nTelegram javob bermadi — xabar guruhda paydo bo'lgan bo'lishi ham, bo'lmasligi ham mumkin. Guruhni tekshirib tanlang. ` +
      `"Qayta yuborish" xabarni ikki marta chiqarishi mumkin.\n\n` +
      rows.map((r) => `#${r.id} ${r.purpose} · ${r.created_at.toISOString().slice(11, 16)} UTC · ${escapeHtml((r.last_error ?? "").slice(0, 80))}`).join("\n"),
    kb: [
      ...rows.map((r) => [
        { text: `✅ #${r.id} chiqdi`, data: cb(ctx, "ud", r.id) },
        { text: `🔁 Qayta`, data: cb(ctx, "ur", r.id) },
        { text: `✖️ Bekor`, data: cb(ctx, "ux", r.id) },
      ]),
      back(ctx, "rep"),
    ],
  };
}

// ---------------------------------------------------------------- entry points

export async function handleAdminCommand(ctx: AppContext, msg: Message, user: User): Promise<void> {
  if (!isBotAdmin(ctx, user.id)) return;
  await setPending(ctx, user.id, null);
  await show(ctx, msg.chat.id, await homeScreen(ctx, user.id));
}

/** Returns true when the message was consumed as input for a pending admin action. */
export async function handleAdminInput(ctx: AppContext, msg: Message, user: User): Promise<boolean> {
  if (!isBotAdmin(ctx, user.id)) return false;
  const sess = await session(ctx, user.id);
  const pending = sess.pending as Pending | null;
  if (!pending) {
    if (msg.document || msg.photo) {
      await ctx.tg.sendMessage({ chat_id: msg.chat.id, text: "Fayl yuborishdan oldin «📚 Materiallar → 📎 Fayl yuklash» yoki «❓ Savollar → 🖼 Rasmlar» ni tanlang." });
      return true;
    }
    return false;
  }
  const group = await currentGroup(ctx, user.id);
  if (!group) {
    await setPending(ctx, user.id, null);
    await show(ctx, msg.chat.id, await groupsScreen(ctx));
    return true;
  }
  const reply = async (text: string) => ctx.tg.sendMessage({ chat_id: msg.chat.id, text, parse_mode: "HTML" });
  const input = msg.text ?? msg.caption ?? "";

  switch (pending.kind) {
    case "setting": {
      const f = fieldByKey(pending.key);
      if (!f) break;
      const cur = await getSettings(ctx, ctx.db, group.id);
      const next = f.apply(cur, input);
      if (typeof next === "string") {
        await reply(`❌ ${escapeHtml(next)}\n${escapeHtml(f.hint)}`);
        return true;
      }
      const res = await ctx.db.transaction().execute(async (tx) => {
        const r = await saveSettings(ctx, tx, group.id, next, user.id, `${f.key}=${f.show(next)}`);
        if (r.ok) await reconcileGroup(ctx, tx, group.id);
        return r;
      });
      if (!res.ok) {
        await reply(`❌ Saqlanmadi:\n${res.errors.map((e) => `• ${escapeHtml(e)}`).join("\n")}`);
        return true;
      }
      await setPending(ctx, user.id, null);
      await show(ctx, msg.chat.id, await homeScreen(ctx, user.id, saved(group.title, `${f.label} = ${escapeHtml(f.show(next))}`)));
      return true;
    }
    case "roster_import": {
      const names = input.split(/\n|;/);
      const added = await ctx.db.transaction().execute((tx) => importRoster(ctx, tx, group.id, names, user.id));
      await setPending(ctx, user.id, null);
      await show(ctx, msg.chat.id, await studentsScreen(ctx, group.id).then((s) => ({ ...s, text: `${saved(group.title, `sinf ro'yxatiga ${added} ta ism qo'shildi`)}\n\n${s.text}` })));
      return true;
    }
    case "material_text": {
      if (input.trim().length < 80) {
        await reply("Matn juda qisqa (kamida 80 belgi). Dars matnini yuboring yoki /cancel.");
        return true;
      }
      const [first, ...rest] = input.trim().split("\n");
      const title = first!.length <= 80 && rest.length ? first! : "Dars matni";
      const id = await ctx.db.transaction().execute((tx) => addTextMaterial(ctx, tx, group.id, title, input, user.id));
      await setPending(ctx, user.id, null);
      await reply(saved(group.title, `material #${id} qabul qilindi, qayta ishlanmoqda. Tayyor bo'lgach xabar beraman.`));
      return true;
    }
    case "material_file": {
      const doc = msg.document;
      const photo = msg.photo?.[msg.photo.length - 1];
      if (!doc && !photo) {
        await reply("TXT, MD, PDF yoki DOCX fayl yuboring (yoki /cancel).");
        return true;
      }
      const res = await addTelegramDocument(
        ctx,
        group.id,
        doc ? { file_id: doc.file_id, ...(doc.file_name ? { file_name: doc.file_name } : {}), ...(doc.file_size ? { file_size: doc.file_size } : {}) } : { file_id: photo!.file_id, file_name: "rasm.jpg", ...(photo!.file_size ? { file_size: photo!.file_size } : {}) },
        user.id,
      );
      await setPending(ctx, user.id, null);
      await reply(res.ok ? saved(group.title, `fayl #${res.materialId} qabul qilindi, qayta ishlanmoqda.`) : `❌ ${escapeHtml(res.reason)}`);
      return true;
    }
    case "picture": {
      const photo = msg.photo?.[msg.photo.length - 1];
      if (!photo || !input.trim()) {
        await reply("Rasmni izoh (caption) bilan yuboring: rasmda nima tasvirlanganini yozing. Rasmni o'zingiz tayyorlagan yoki foydalanishga ruxsatingiz bo'lsin.");
        return true;
      }
      const id = await addPictureAsset(ctx, group.id, { file_id: photo.file_id, ...(photo.file_unique_id ? { file_unique_id: photo.file_unique_id } : {}) }, input.trim(), user.id);
      await setPending(ctx, user.id, null);
      await reply(saved(group.title, `rasm #${id} qo'shildi, tekshirilmoqda.`));
      return true;
    }
    case "verdict_reason": {
      if (input.trim().length < 3) {
        await reply("Sabab yozing (kamida 3 belgi).");
        return true;
      }
      const r = await adminCorrectVerdict(ctx, pending.submissionId, pending.verdict, input, user.id);
      await setPending(ctx, user.id, null);
      await reply(r.ok ? saved(group.title, `javob #${pending.submissionId} → ${pending.verdict === "correct" ? "to'g'ri" : "noto'g'ri"}. Hisobot yangilanadi.`) : `❌ ${r.error}`);
      return true;
    }
    case "reject_reason": {
      const ok = await ctx.db.transaction().execute((tx) => rejectVersion(ctx, tx, pending.versionId, user.id, input.trim().slice(0, 300) || "admin"));
      await setPending(ctx, user.id, null);
      await show(ctx, msg.chat.id, { ...(await reviewScreen(ctx, group.id, 0)), text: `${ok ? saved(group.title, `savol #${pending.versionId} rad etildi`) : "Savol topilmadi."}\n\n${(await reviewScreen(ctx, group.id, 0)).text}` });
      return true;
    }
  }
  return false;
}

export async function handleAdminCallback(ctx: AppContext, a: { user: User; chatId: number; messageId: number; action: string; args: string[] }): Promise<string | undefined> {
  // Server-side permission check on every button press.
  if (!isBotAdmin(ctx, a.user.id)) return "Ruxsat yo'q.";
  const adminId = a.user.id;
  const edit = (s: Screen) => show(ctx, a.chatId, s, a.messageId);
  if (a.action === "home") return void (await edit(await homeScreen(ctx, adminId)));
  if (a.action === "groups") return void (await edit(await groupsScreen(ctx)));
  if (a.action === "gsel") {
    const gid = intArg(a.args[0]);
    const g = gid ? await ctx.db.selectFrom("groups").selectAll().where("id", "=", gid).executeTakeFirst() : undefined;
    if (!g) return "Guruh topilmadi.";
    await session(ctx, adminId);
    await ctx.db.updateTable("admin_sessions").set({ group_id: g.id, pending: null }).where("admin_telegram_id", "=", adminId).execute();
    return void (await edit(await homeScreen(ctx, adminId, `✅ Tanlandi: <b>${escapeHtml(g.title)}</b>`)));
  }

  const group = await currentGroup(ctx, adminId);
  if (!group) return void (await edit(await groupsScreen(ctx)));
  const gid = group.id;
  const done = async (what: string, next: Screen) => edit({ ...next, text: `${saved(group.title, what)}\n\n${next.text}` });

  switch (a.action) {
    case "st":
      return void (await edit(await studentsScreen(ctx, gid)));
    case "stl":
      return void (await edit(await studentListScreen(ctx, gid, intArg0(a.args[0]) ?? 0)));
    case "sd": {
      const sc = await studentDetail(ctx, gid, intArg(a.args[0]) ?? 0);
      return sc ? void (await edit(sc)) : "Topilmadi.";
    }
    case "ss": {
      const sid = intArg(a.args[0]);
      const status = a.args[1] === "e" ? "eligible" : a.args[1] === "b" ? "blocked" : a.args[1] === "a" ? "archived" : null;
      if (!sid || !status) return "Noto'g'ri.";
      const st = await ctx.db.selectFrom("students").select(["group_id"]).where("id", "=", sid).executeTakeFirst();
      if (!st || st.group_id !== gid) return "Bu o'quvchi tanlangan guruhda emas.";
      await ctx.db.transaction().execute((tx) => setStudentStatus(ctx, tx, sid, status, adminId));
      const label = status === "eligible" ? "ruxsat berildi" : status === "blocked" ? "bloklandi (avvalgi natijalar saqlanadi)" : "arxivlandi";
      return void (await done(`o'quvchi ${label}`, (await studentDetail(ctx, gid, sid))!));
    }
    case "sim":
      await setPending(ctx, adminId, { kind: "roster_import" });
      return void (await edit({ text: `📝 <b>${escapeHtml(group.title)}</b> sinf ro'yxati: har bir qatorda bitta to'liq ism yuboring.\nBekor qilish: /cancel`, kb: [back(ctx, "st")] }));
    case "rl": {
      const page = intArg0(a.args[0]) ?? 0;
      const rows = await ctx.db.selectFrom("roster_entries").select(["id", "full_name"]).where("group_id", "=", gid).where("archived", "=", false).where("student_id", "is", null).orderBy("full_name").offset(page * PAGE).limit(PAGE).execute();
      return void (await edit({
        text: `🔗 <b>Bog'lanmagan ismlar</b>\n${rows.map((r) => `• ${escapeHtml(r.full_name)}`).join("\n") || "Hammasi bog'langan."}\n\nBog'lash uchun o'quvchini «📋 O'quvchilar ro'yxati» dan tanlang. Ism bo'yicha avtomatik bog'lanmaydi.`,
        kb: [...(rows.length === PAGE ? [[{ text: "▶️", data: cb(ctx, "rl", page + 1) }]] : []), back(ctx, "st")],
      }));
    }
    case "slk": {
      const sid = intArg(a.args[0]);
      const page = intArg0(a.args[1]) ?? 0;
      if (!sid) return "Noto'g'ri.";
      const rows = await ctx.db.selectFrom("roster_entries").select(["id", "full_name"]).where("group_id", "=", gid).where("archived", "=", false).where("student_id", "is", null).orderBy("full_name").offset(page * PAGE).limit(PAGE + 1).execute();
      return void (await edit({
        text: "🔗 Qaysi ismga bog'laymiz?",
        kb: [
          ...rows.slice(0, PAGE).map((r) => [{ text: r.full_name.slice(0, 60), data: cb(ctx, "slr", sid, r.id) }]),
          ...(rows.length > PAGE ? [[{ text: "▶️", data: cb(ctx, "slk", sid, page + 1) }]] : []),
          back(ctx, "st"),
        ],
      }));
    }
    case "slr": {
      const sid = intArg(a.args[0]);
      const rid = intArg(a.args[1]);
      if (!sid || !rid) return "Noto'g'ri.";
      const [st, re] = await Promise.all([
        ctx.db.selectFrom("students").select("group_id").where("id", "=", sid).executeTakeFirst(),
        ctx.db.selectFrom("roster_entries").select("group_id").where("id", "=", rid).executeTakeFirst(),
      ]);
      if (st?.group_id !== gid || re?.group_id !== gid) return "Boshqa guruhga tegishli.";
      await ctx.db.transaction().execute((tx) => linkRoster(ctx, tx, rid, sid, adminId));
      return void (await done("o'quvchi sinf ro'yxatiga bog'landi", (await studentDetail(ctx, gid, sid))!));
    }
    case "sul": {
      const rid = intArg(a.args[0]);
      const sid = intArg(a.args[1]);
      if (!rid || !sid) return "Noto'g'ri.";
      const re = await ctx.db.selectFrom("roster_entries").select("group_id").where("id", "=", rid).executeTakeFirst();
      if (re?.group_id !== gid) return "Boshqa guruhga tegishli.";
      await ctx.db.transaction().execute((tx) => unlinkRoster(ctx, tx, rid, adminId));
      return void (await done("bog'lanish uzildi", (await studentDetail(ctx, gid, sid))!));
    }
    case "setup": {
      const s = await getSettings(ctx, ctx.db, gid);
      await ctx.db.transaction().execute((tx) =>
        enqueue(tx, {
          groupId: gid,
          chatId: group.chat_id,
          method: "sendMessage",
          payload: { chat_id: group.chat_id, text: s.language === "ru" ? "Нажмите кнопку, чтобы включить ответы в личном чате с ботом." : s.language === "en" ? "Tap the button to enable private answers with the bot." : "Javoblarni bot bilan shaxsiy chatda yozish uchun tugmani bosing.", reply_markup: { inline_keyboard: [[{ text: "🤖 Botni ishga tushirish", url: `https://t.me/${ctx.bot.username}?start=s_${gid}` }]] } },
          dedupeKey: `setup-manual:${gid}:${ctx.clock.now().getTime()}`,
          purpose: "setup_prompt",
        }),
      );
      return void (await done("guruhga shaxsiy chat tugmasi yuborildi", await studentsScreen(ctx, gid)));
    }

    case "mat":
      return void (await edit(await materialsScreen(ctx, gid)));
    case "mtx":
      await setPending(ctx, adminId, { kind: "material_text" });
      return void (await edit({ text: `➕ <b>${escapeHtml(group.title)}</b> uchun dars matnini yuboring. Birinchi qisqa qator sarlavha bo'ladi.\nBekor qilish: /cancel`, kb: [back(ctx, "mat")] }));
    case "mfl":
      await setPending(ctx, adminId, { kind: "material_file" });
      return void (await edit({ text: `📎 <b>${escapeHtml(group.title)}</b> uchun TXT, MD, PDF yoki DOCX fayl yuboring (≤ ${Math.round(Math.min(ctx.cfg.UPLOAD_MAX_BYTES, TG.GET_FILE_MAX_BYTES) / 1048576)} MB).${ctx.cfg.OCR_ENABLED ? " Skanerlangan PDF/rasm OCR bilan o'qiladi." : ""}\nBekor qilish: /cancel`, kb: [back(ctx, "mat")] }));
    case "mta": {
      const mid = intArg(a.args[0]);
      const m = mid ? await ctx.db.selectFrom("materials").select(["group_id", "active", "title"]).where("id", "=", mid).executeTakeFirst() : undefined;
      if (!m || m.group_id !== gid) return "Topilmadi.";
      await ctx.db.updateTable("materials").set({ active: !m.active }).where("id", "=", mid!).execute();
      return void (await done(`"${escapeHtml(m.title)}" ${m.active ? "faol to'plamdan chiqarildi" : "faol to'plamga qo'shildi"}`, await materialsScreen(ctx, gid)));
    }
    case "mdl": {
      const mid = intArg(a.args[0]);
      return void (await edit({ text: `🗑 Material #${mid} o'chirilsinmi? Fayl va matn o'chiriladi; avval yaratilgan savollar qoladi.`, kb: [[{ text: "Ha, o'chirish", data: cb(ctx, "mdc", mid ?? 0) }], back(ctx, "mat")] }));
    }
    case "mdc": {
      const mid = intArg(a.args[0]);
      const m = mid ? await ctx.db.selectFrom("materials").select("group_id").where("id", "=", mid).executeTakeFirst() : undefined;
      if (!m || m.group_id !== gid) return "Topilmadi.";
      await ctx.db.transaction().execute((tx) => deleteMaterial(ctx, tx, mid!, adminId));
      return void (await done(`material #${mid} o'chirildi`, await materialsScreen(ctx, gid)));
    }

    case "q":
      return void (await edit(await questionsScreen(ctx, gid)));
    case "qg":
      return void (await edit({ text: "✨ Qaysi o'yin turi uchun savol yaratamiz?", kb: [...GAME_TYPES.map((t, i) => [{ text: gameName("uz", t), data: cb(ctx, "qgt", i) }]), back(ctx, "q")] }));
    case "qgt": {
      const ti = intArg0(a.args[0]);
      if (ti === null || !GAME_TYPES[ti]) return "Noto'g'ri.";
      return void (await edit({ text: `✨ ${gameName("uz", GAME_TYPES[ti])}: nechta savol?`, kb: [[3, 6, 10, 15].map((n) => ({ text: String(n), data: cb(ctx, "qgc", ti, n) })), back(ctx, "qg")] }));
    }
    case "qgc": {
      const ti = intArg0(a.args[0]);
      const n = intArg(a.args[1]);
      if (ti === null || !GAME_TYPES[ti] || !n) return "Noto'g'ri.";
      const res = await ctx.db.transaction().execute((tx) => createBatch(ctx, tx, { groupId: gid, gameType: GAME_TYPES[ti]!, count: n, actorId: adminId }));
      if (!res.ok) return void (await edit({ text: `❌ ${escapeHtml(res.reason)}`, kb: [back(ctx, "q")] }));
      const s = await getSettings(ctx, ctx.db, gid);
      const split = splitSourceExtra(n, s.sourceRatio);
      return void (await done(`${n} ta ${gameName("uz", GAME_TYPES[ti]!)} savoli navbatga qo'yildi (${split.source} darsdan + ${split.extra} qo'shimcha). Tayyor bo'lgach tasdiqlash uchun xabar beraman.`, await questionsScreen(ctx, gid)));
    }
    case "qr":
      return void (await edit(await reviewScreen(ctx, gid, intArg0(a.args[0]) ?? 0)));
    case "qa": {
      const vid = intArg(a.args[0]);
      const v = vid ? await ctx.db.selectFrom("question_versions").select("group_id").where("id", "=", vid).executeTakeFirst() : undefined;
      if (!v || v.group_id !== gid) return "Topilmadi.";
      const ok = await ctx.db.transaction().execute((tx) => approveVersion(ctx, tx, vid!, adminId));
      return void (await done(ok ? `savol #${vid} tasdiqlandi` : "allaqachon ko'rib chiqilgan", await reviewScreen(ctx, gid, 0)));
    }
    case "qx": {
      const vid = intArg(a.args[0]);
      const v = vid ? await ctx.db.selectFrom("question_versions").select("group_id").where("id", "=", vid).executeTakeFirst() : undefined;
      if (!v || v.group_id !== gid) return "Topilmadi.";
      await setPending(ctx, adminId, { kind: "reject_reason", versionId: vid! });
      return void (await edit({ text: `❌ Savol #${vid} rad etish sababini yozing (masalan "javob noaniq").`, kb: [back(ctx, "q")] }));
    }
    case "qp": {
      const assets = await ctx.db.selectFrom("picture_assets").select(["id", "description", "status"]).where("group_id", "=", gid).orderBy("id", "desc").limit(8).execute();
      return void (await edit({
        text: `🖼 <b>Rasmlar</b> (faqat o'zingiz tayyorlagan yoki ruxsatli rasmlar)\n${assets.map((x) => `#${x.id} ${x.status === "approved" ? "✅" : x.status === "rejected" ? "❌" : "⏳"} ${escapeHtml(x.description.slice(0, 60))}`).join("\n") || "Hali rasm yo'q."}`,
        kb: [
          [{ text: "➕ Rasm yuklash", data: cb(ctx, "qpu") }],
          ...assets.filter((x) => x.status !== "approved").map((x) => [{ text: `✅ #${x.id} ni tasdiqlash`, data: cb(ctx, "qpa", x.id) }]),
          back(ctx, "q"),
        ],
      }));
    }
    case "qpu":
      await setPending(ctx, adminId, { kind: "picture" });
      return void (await edit({ text: "🖼 Rasmni izoh bilan yuboring: izohda rasmda nima borligini yozing (masalan: \"Olma, qizil meva\").\nBekor qilish: /cancel", kb: [back(ctx, "qp")] }));
    case "qpa": {
      const aid = intArg(a.args[0]);
      const asset = aid ? await ctx.db.selectFrom("picture_assets").select("group_id").where("id", "=", aid).executeTakeFirst() : undefined;
      if (!asset || asset.group_id !== gid) return "Topilmadi.";
      await ctx.db.updateTable("picture_assets").set({ status: "approved" }).where("id", "=", aid!).execute();
      return void (await done(`rasm #${aid} qo'lda tasdiqlandi`, await questionsScreen(ctx, gid)));
    }

    case "sch":
      return void (await edit(await scheduleScreen(ctx, gid)));
    case "sdt": {
      const d = intArg(a.args[0]);
      if (!d || d > 7) return "Noto'g'ri.";
      const cur = await getSettings(ctx, ctx.db, gid);
      const days = cur.activeDays.includes(d) ? cur.activeDays.filter((x) => x !== d) : [...cur.activeDays, d].sort();
      const res = await ctx.db.transaction().execute(async (tx) => {
        const r = await saveSettings(ctx, tx, gid, { ...cur, activeDays: days }, adminId, `activeDays=${days.join(",")}`);
        if (r.ok) await reconcileGroup(ctx, tx, gid);
        return r;
      });
      if (!res.ok) return void (await edit({ ...(await scheduleScreen(ctx, gid)), text: `❌ ${res.errors.map(escapeHtml).join("\n")}` }));
      return void (await done(`${dayName(d)} ${days.includes(d) ? "faol" : "o'yinsiz"}`, await scheduleScreen(ctx, gid)));
    }
    case "se": {
      const f = fieldByKey(a.args[0] ?? "");
      if (!f) return "Noto'g'ri.";
      const cur = await getSettings(ctx, ctx.db, gid);
      await setPending(ctx, adminId, { kind: "setting", key: f.key });
      return void (await edit({ text: `✏️ <b>${escapeHtml(group.title)}</b> — ${escapeHtml(f.label)}\nHozir: <b>${escapeHtml(f.show(cur))}</b>\n${escapeHtml(f.hint)}\nBekor qilish: /cancel`, kb: [back(ctx)] }));
    }
    case "tg": {
      const t = TOGGLES.find((x) => x.key === a.args[0]);
      if (!t) return "Noto'g'ri.";
      const cur = await getSettings(ctx, ctx.db, gid);
      const next = t.set(cur, !t.get(cur));
      const res = await ctx.db.transaction().execute((tx) => saveSettings(ctx, tx, gid, next, adminId, `${t.key}=${t.get(next)}`));
      if (!res.ok) return res.errors.join("; ").slice(0, 190);
      const screen = t.key === "sk" ? await pointsScreen(ctx, gid) : t.key === "si" ? await reportsScreen(ctx, gid) : await aiScreen(ctx, gid);
      return void (await done(`${t.label}: ${t.get(next) ? "ha" : "yo'q"}`, screen));
    }
    case "pts":
      return void (await edit(await pointsScreen(ctx, gid)));
    case "ai":
      return void (await edit(await aiScreen(ctx, gid)));

    case "gt":
      return void (await edit(await gameTypesScreen(ctx, gid)));
    case "gtd": {
      const d = intArg(a.args[0]);
      if (!d || d > 7) return "Noto'g'ri.";
      return void (await edit({ text: `🎮 ${dayName(d)} uchun o'yin turi:`, kb: typeChoice(ctx, "gts", d) }));
    }
    case "gts": {
      const d = intArg(a.args[0]);
      const ti = intArg0(a.args[1]);
      if (!d || d > 7 || ti === null) return "Noto'g'ri.";
      const type = ti === 9 ? null : (GAME_TYPES[ti] ?? undefined);
      if (type === undefined) return "Noto'g'ri.";
      const cur = await getSettings(ctx, ctx.db, gid);
      const next = { ...cur, weekdayGame: { ...cur.weekdayGame, [String(d)]: type } } as GroupSettings;
      const res = await ctx.db.transaction().execute(async (tx) => {
        const r = await saveSettings(ctx, tx, gid, next, adminId, `weekday${d}=${type}`);
        if (r.ok) await reconcileGroup(ctx, tx, gid);
        return r;
      });
      if (!res.ok) return void (await edit({ ...(await gameTypesScreen(ctx, gid)), text: `❌ ${res.errors.map(escapeHtml).join("\n")}` }));
      return void (await done(`${dayName(d)}: ${type ? gameName("uz", type) : "o'yin yo'q"} (boshlanmagan kunlarga tegishli)`, await gameTypesScreen(ctx, gid)));
    }
    case "gto": {
      const off = intArg0(a.args[0]);
      if (off === null || off > 1) return "Noto'g'ri.";
      return void (await edit({ text: `📅 ${off === 0 ? "Bugungi" : "Ertangi"} kun uchun o'yin turi (faqat birinchi savol yuborilmaguncha):`, kb: typeChoice(ctx, "gtos", off) }));
    }
    case "gtos": {
      const off = intArg0(a.args[0]);
      const ti = intArg0(a.args[1]);
      if (off === null || off > 1 || ti === null) return "Noto'g'ri.";
      const type = ti === 9 ? null : (GAME_TYPES[ti] ?? undefined);
      if (type === undefined) return "Noto'g'ri.";
      const s = await getSettings(ctx, ctx.db, gid);
      const date = addDays(localDateOf(ctx.clock.now(), s.timezone), off);
      const res = await ctx.db.transaction().execute((tx) => overrideDayType(ctx, tx, gid, date, type, adminId));
      if (!res.ok) return void (await edit({ ...(await gameTypesScreen(ctx, gid)), text: `❌ ${escapeHtml(res.reason ?? "")}` }));
      return void (await done(`${date} turi: ${type ? gameName("uz", type) : "o'yin yo'q"}`, await gameTypesScreen(ctx, gid)));
    }

    case "rep":
      return void (await edit(await reportsScreen(ctx, gid)));
    case "fin":
      return void (await edit({ text: "🏁 Ochiq savol hozir yopiladi (shu paytgacha kelgan javoblar hisoblanadi), qolganlari bekor qilinadi va kunlik hisobot hozir yuboriladi. Davom etasizmi?", kb: [[{ text: "Ha, yakunlash", data: cb(ctx, "finc") }], back(ctx, "rep")] }));
    case "finc": {
      const ok = await finishAndReport(ctx, gid, adminId);
      return void (await done(ok ? "kun yakunlanmoqda, hisobot bir necha soniyada chiqadi" : "bugun yakunlanadigan o'yin yo'q", await reportsScreen(ctx, gid)));
    }
    case "rv":
    case "rc":
      return void (await edit(await submissionScreen(ctx, gid, a.action, intArg0(a.args[0]) ?? 0)));
    case "rvv": {
      const sid = intArg(a.args[0]);
      const verdict = a.args[1] === "c" ? "correct" : a.args[1] === "i" ? "incorrect" : null;
      if (!sid || !verdict) return "Noto'g'ri.";
      const sub = await ctx.db.selectFrom("submissions").select("group_id").where("id", "=", sid).executeTakeFirst();
      if (!sub || sub.group_id !== gid) return "Topilmadi.";
      await setPending(ctx, adminId, { kind: "verdict_reason", submissionId: sid, verdict });
      return void (await edit({ text: `✏️ Javob #${sid} → ${verdict === "correct" ? "to'g'ri" : "noto'g'ri"}. Sababini yozing:`, kb: [back(ctx, "rep")] }));
    }
    case "unc":
      return void (await edit(await uncertainScreen(ctx, gid)));
    case "ud":
    case "ur":
    case "ux": {
      const oid = intArg(a.args[0]);
      const row = oid ? await ctx.db.selectFrom("outbox").select("group_id").where("id", "=", oid).executeTakeFirst() : undefined;
      if (!row || row.group_id !== gid) return "Topilmadi.";
      const action = a.action === "ud" ? "delivered" : a.action === "ur" ? "resend" : "cancel";
      const ok = await resolveUncertain(ctx, oid!, action, adminId);
      return void (await done(ok ? `#${oid}: ${action === "delivered" ? "chiqqan deb belgilandi" : action === "resend" ? "qayta yuborish navbatda" : "bekor qilindi"}` : "allaqachon hal qilingan", await uncertainScreen(ctx, gid)));
    }

    case "stop":
      return void (await edit({
        text: `⛔ <b>${escapeHtml(group.title)}</b>: bugungi o'yinlarni to'xtatish.\nOchiq savol bekor qilinadi (ball berilmaydi, seriya va aniqlikka ta'sir qilmaydi), yuborilmaganlar bekor qilinadi. Avvalgi natijalar saqlanadi.`,
        kb: [[{ text: "⛔ To'xtatish (hisobot belgilangan vaqtda)", data: cb(ctx, "stp", 0) }], [{ text: "⛔🏁 To'xtatish va hozir hisobot", data: cb(ctx, "stp", 1) }], back(ctx)],
      }));
    case "stp": {
      const now = intArg0(a.args[0]) === 1;
      const r = await stopToday(ctx, gid, adminId, now);
      if (!r.ok) return void (await edit(await homeScreen(ctx, adminId, "Bugun to'xtatiladigan o'yin yo'q.")));
      return void (await edit(await homeScreen(ctx, adminId, saved(group.title, `bugungi o'yinlar to'xtatildi (bekor: ochiq ${r.canceledActive}, navbatdagi ${r.canceledScheduled})${now ? ", hisobot hozir chiqadi" : ""}`))));
    }
  }
  return "Noma'lum amal.";
}

export { SETTING_FIELDS };
