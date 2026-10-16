import { readFileSync } from "node:fs";
import type { GameType } from "../../src/domain/gameTypes.js";
import type { GroupSettings } from "../../src/domain/settings.js";
import { atLocal } from "../../src/domain/time.js";
import { addGroup, addLesson, createHarness, joinStudent, prepareQuestions, settle, student, type Harness } from "../../src/sim/harness.js";

export const TZ = "Asia/Tashkent";
export const CHAT = -1001000000001;
/** 2026-10-19 is a Monday. Index by ISO weekday. */
export const DATE_FOR: Record<GameType, string> = {
  quiz_poll: "2026-10-19",
  find_mistake: "2026-10-20",
  guess_word: "2026-10-21",
  true_false: "2026-10-22",
  picture_quiz: "2026-10-23",
  emoji_puzzle: "2026-10-24",
};
export const LESSON = readFileSync(new URL("../../samples/lesson-js-arrays-uz.md", import.meta.url), "utf8");

export async function newHarness(start = "2026-10-18T03:00:00Z"): Promise<Harness> {
  return createHarness({ databaseUrl: process.env.TEST_DATABASE_URL!, start: new Date(start) });
}

export interface Day {
  h: Harness;
  groupId: number;
  date: string;
}

/**
 * Group with `students` members, the sample lesson, approved questions of `gameType`, clock on that
 * type's weekday at 17:59 with plans created.
 */
export async function setupDay(gameType: GameType, opts: { students?: number; questions?: number; settings?: Partial<GroupSettings>; h?: Harness; chatId?: number; pictures?: number } = {}): Promise<Day> {
  const h = opts.h ?? (await newHarness());
  const date = DATE_FOR[gameType];
  h.clock.set(atLocal(date, "07:00", TZ));
  const chatId = opts.chatId ?? CHAT;
  const groupId = await addGroup(h, chatId, `Sinf ${chatId}`, { topic: "JavaScript massivlari", level: "7-sinf", ...opts.settings });
  for (let i = 0; i < (opts.students ?? 5); i++) await joinStudent(h, chatId, student(i));
  await addLesson(h, groupId, LESSON);
  if (gameType === "picture_quiz") {
    const { addPictureAsset } = await import("../../src/services/materials.js");
    for (let k = 0; k < (opts.pictures ?? 6); k++) {
      h.tg.files.set(`ph${chatId}${k}`, { path: `p/${chatId}${k}.jpg`, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, k]) });
      await addPictureAsset(h.ctx, groupId, { file_id: `ph${chatId}${k}` }, ["Olma", "Kitob", "Daraxt", "Mashina", "Soat", "Qalam"][k % 6]!, 1001);
    }
    await h.jobs.drain();
  }
  if ((opts.questions ?? 8) > 0) await prepareQuestions(h, groupId, gameType, opts.questions ?? 8);
  h.clock.set(atLocal(date, "17:59", TZ));
  await settle(h);
  return { h, groupId, date };
}

/** Move the clock to local HH:MM(:SS) of the day and run the scheduler + jobs. */
export async function at(d: Day, hhmm: string, seconds = 0): Promise<void> {
  d.h.clock.set(new Date(atLocal(d.date, hhmm, TZ).getTime() + seconds * 1000));
  await settle(d.h);
}

export async function openInstance(d: Day) {
  return d.h.ctx.db.selectFrom("question_instances").selectAll().where("day_plan_id", "=", await todayPlanId(d)).where("state", "in", ["open", "closing"]).orderBy("slot").executeTakeFirst();
}

export async function ledgerFor(d: Day) {
  return d.h.ctx.db.selectFrom("score_ledger").selectAll().where("group_id", "=", d.groupId).orderBy("id").execute();
}

export async function studentId(d: Day, i: number): Promise<number> {
  const s = await d.h.ctx.db.selectFrom("students").select("id").where("group_id", "=", d.groupId).where("telegram_user_id", "=", student(i).id).executeTakeFirstOrThrow();
  return s.id;
}

export async function contentOf(d: Day, instanceId: number) {
  const r = await d.h.ctx.db
    .selectFrom("question_instances as qi")
    .innerJoin("question_versions as v", "v.id", "qi.question_version_id")
    .select(["v.content", "v.difficulty"])
    .where("qi.id", "=", instanceId)
    .executeTakeFirstOrThrow();
  return r as { content: Record<string, unknown>; difficulty: string };
}

export function adminMessages(h: Harness): string[] {
  return h.tg.messagesTo(1001).map((m) => m.text ?? "");
}

export async function todayPlanId(d: Day): Promise<number> {
  const p = await d.h.ctx.db.selectFrom("day_plans").select("id").where("group_id", "=", d.groupId).where("local_date", "=", d.date).executeTakeFirstOrThrow();
  return p.id;
}

/** Answer the currently open question of the day as student i (correctly or not), via the real router. */
export async function answerOpen(d: Day, i: number, correct: boolean): Promise<void> {
  const { pollAnswerUpdate, callbackUpdate, privateText } = await import("../../src/sim/harness.js");
  const inst = await openInstance(d);
  if (!inst) throw new Error("no open question");
  const { content } = await contentOf(d, inst.id);
  const c = content as Record<string, unknown>;
  const u = student(i);
  const chat = (await d.h.ctx.db.selectFrom("groups").select("chat_id").where("id", "=", d.groupId).executeTakeFirstOrThrow()).chat_id;
  switch (inst.game_type) {
    case "quiz_poll":
    case "true_false": {
      const right = inst.game_type === "true_false" ? (c.isTrue ? 0 : 1) : (c.correctIndex as number);
      const n = inst.game_type === "true_false" ? 2 : (c.options as string[]).length;
      await d.h.router.handleUpdate(pollAnswerUpdate(d.h, u, inst.poll_id!, correct ? right : (right + 1) % n));
      break;
    }
    case "emoji_puzzle":
    case "picture_quiz": {
      const right = c.correctIndex as number;
      await d.h.router.handleUpdate(callbackUpdate(d.h, u, chat, inst.message_id ?? 1, d.h.ctx.callbacks.encode("a", inst.id, correct ? right : (right + 1) % 4)));
      break;
    }
    case "find_mistake":
      await d.h.router.handleUpdate(privateText(d.h, u, `/start a_${inst.id}`));
      await d.h.router.handleUpdate(privateText(d.h, u, correct ? (c.fixedCode as string) : (c.code as string)));
      await d.h.router.handleUpdate(callbackUpdate(d.h, u, u.id, 1, d.h.ctx.callbacks.encode("fc", inst.id)));
      break;
    case "guess_word":
      await d.h.router.handleUpdate(privateText(d.h, u, `/start a_${inst.id}`));
      await d.h.router.handleUpdate(privateText(d.h, u, correct ? (c.answer as string) : "boshqa"));
      break;
  }
}

/** One compact game day: publish at 18:00, answers, close, report at the day end (questionsPerDay = 1). */
export async function playDay(d: Day, answers: Record<number, boolean>): Promise<void> {
  await at(d, "18:00");
  for (const [i, ok] of Object.entries(answers)) await answerOpen(d, Number(i), ok);
  await at(d, "18:10", 5);
  await at(d, "18:10", 10);
  await at(d, "18:30");
  await at(d, "18:31");
}
