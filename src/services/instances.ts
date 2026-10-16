import type { Executor } from "../db/db.js";
import type { Row } from "../db/schema.js";
import { parseContent, type AnyContent } from "../domain/content.js";
import type { GameType } from "../domain/gameTypes.js";

export interface LoadedInstance {
  inst: Row<"question_instances">;
  gameType: GameType;
  content: AnyContent | null;
  versionId: number | null;
  localDate: string;
  groupChatId: number;
  groupId: number;
  language: string;
}

/** One query (hot path for every answer): the instance with its day, group chat and question content. */
export async function loadInstance(ex: Executor, id: number): Promise<LoadedInstance | null> {
  const row = await ex
    .selectFrom("question_instances as qi")
    .innerJoin("day_plans as dp", "dp.id", "qi.day_plan_id")
    .innerJoin("groups as g", "g.id", "qi.group_id")
    .leftJoin("question_versions as v", "v.id", "qi.question_version_id")
    .selectAll("qi")
    .select(["dp.local_date", "g.chat_id as group_chat_id", "v.content as v_content", "v.language as v_language"])
    .where("qi.id", "=", id)
    .executeTakeFirst();
  if (!row) return null;
  const { local_date, group_chat_id, v_content, v_language, ...inst } = row;
  return {
    inst: inst as Row<"question_instances">,
    gameType: inst.game_type as GameType,
    content: v_content ? parseContent(inst.game_type as GameType, v_content) : null,
    versionId: inst.question_version_id,
    localDate: local_date,
    groupChatId: group_chat_id,
    groupId: inst.group_id,
    language: v_language ?? "uz",
  };
}

/** States in which a delivered question accepts answers (server deadline still applies). */
export function acceptsAnswers(state: string): boolean {
  return state === "open" || state === "uncertain";
}
