import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

/** Kysely table types. BIGINT columns arrive as JS numbers via a safe-integer-checked parser (see db.ts). */

type Id = Generated<number>;
type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
type Ts = ColumnType<Date, Date | string, Date | string>;
type TsNull = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type TsDefault = ColumnType<Date, Date | string | undefined, Date | string>;
/** DATE columns are kept as 'YYYY-MM-DD' strings (local calendar dates of the group). */
type LocalDate = string;
type Json<T = unknown> = ColumnType<T, T | string, T | string>;

export interface GroupsTable {
  id: Id;
  chat_id: number;
  title: Generated<string>;
  status: Generated<"active" | "left" | "disabled">;
  bot_is_admin: Generated<boolean>;
  member_count: number | null;
  member_count_at: TsNull;
  created_at: CreatedAt;
  updated_at: TsDefault;
}

export interface GroupSettingsTable {
  group_id: number;
  settings: Json<Record<string, unknown>>;
  version: Generated<number>;
  updated_at: TsDefault;
  updated_by: number | null;
}

export interface TelegramUsersTable {
  id: number;
  first_name: Generated<string>;
  last_name: string | null;
  username: string | null;
  is_bot: Generated<boolean>;
  private_chat_ready: Generated<boolean>;
  private_started_at: TsNull;
  updated_at: TsDefault;
}

export type StudentStatus = "eligible" | "blocked" | "archived";
export interface StudentsTable {
  id: Id;
  group_id: number;
  telegram_user_id: number;
  status: Generated<StudentStatus>;
  membership: Generated<"member" | "left">;
  discovered_via: string;
  first_seen_at: TsDefault;
  updated_at: TsDefault;
}

export interface RosterEntriesTable {
  id: Id;
  group_id: number;
  full_name: string;
  student_id: number | null;
  archived: Generated<boolean>;
  created_by: number | null;
  created_at: CreatedAt;
}

export interface EligibilityIntervalsTable {
  id: Id;
  student_id: number;
  group_id: number;
  starts_at: Ts;
  ends_at: TsNull;
}

export interface EligibilityEventsTable {
  id: Id;
  student_id: number;
  group_id: number;
  event: string;
  eligible_after: boolean;
  actor_id: number | null;
  reason: string | null;
  at: Ts;
}

export interface AdminSessionsTable {
  admin_telegram_id: number;
  group_id: number | null;
  pending: Json<Record<string, unknown>> | null;
  updated_at: TsDefault;
}

export interface AuditEventsTable {
  id: Id;
  group_id: number | null;
  actor_id: number | null;
  action: string;
  details: Json<Record<string, unknown>>;
  at: TsDefault;
}

export interface MaterialsTable {
  id: Id;
  group_id: number;
  title: string;
  kind: "text" | "txt" | "md" | "pdf" | "docx" | "image";
  file_name: string | null;
  mime: string | null;
  size_bytes: number | null;
  telegram_file_id: string | null;
  raw_bytes: Buffer | null;
  file_hash: string | null;
  content_hash: string | null;
  status: Generated<"pending" | "processing" | "ready" | "failed" | "deleted">;
  error: string | null;
  page_count: number | null;
  extraction_method: string | null;
  quality: number | null;
  active: Generated<boolean>;
  created_by: number | null;
  created_at: CreatedAt;
  deleted_at: TsNull;
}

export interface MaterialSectionsTable {
  id: Id;
  material_id: number;
  idx: number;
  ref: string;
  text: string;
}

export interface PictureAssetsTable {
  id: Id;
  group_id: number;
  telegram_file_id: string;
  file_unique_id: string | null;
  description: string;
  status: Generated<"pending_review" | "approved" | "rejected">;
  review: Json<Record<string, unknown>> | null;
  uploaded_by: number | null;
  created_at: CreatedAt;
}

export interface GenerationBatchesTable {
  id: Id;
  group_id: number;
  game_type: string;
  language: string;
  topic: Generated<string>;
  level: Generated<string>;
  requested_count: number;
  source_count: number;
  extra_count: number;
  difficulty_plan: Json<string[]>;
  material_ids: ColumnType<number[], number[] | undefined, number[]>;
  input_hash: string;
  status: Generated<"queued" | "generating" | "reviewing" | "done" | "failed" | "partial">;
  error: string | null;
  attempts: Generated<number>;
  target_date: LocalDate | null;
  created_by: number | null;
  created_at: CreatedAt;
  finished_at: TsNull;
}

export interface QuestionsTable {
  id: Id;
  group_id: number;
  game_type: string;
  origin: "source" | "extra";
  batch_id: number | null;
  current_version_id: number | null;
  created_at: CreatedAt;
}

export type ReviewStatus = "draft" | "validated" | "ai_rejected" | "approved" | "rejected" | "superseded";
export interface QuestionVersionsTable {
  id: Id;
  question_id: number;
  group_id: number;
  version: number;
  game_type: string;
  language: string;
  difficulty: "easy" | "medium" | "hard";
  origin: "source" | "extra";
  content: Json<Record<string, unknown>>;
  source_refs: Json<{ sectionId: number; ref: string }[]>;
  source_excerpt: Generated<string>;
  content_hash: string;
  search_text: string;
  review_status: Generated<ReviewStatus>;
  validation_errors: Json<string[]>;
  ai_review: Json<Record<string, unknown>> | null;
  attempt: Generated<number>;
  approved_by: number | null;
  approved_at: TsNull;
  rejected_reason: string | null;
  published_at: TsNull;
  created_at: CreatedAt;
}

export type DayPlanStatus = "planned" | "active" | "finishing" | "finished" | "canceled" | "off";
export interface DayPlansTable {
  id: Id;
  group_id: number;
  local_date: LocalDate;
  game_type: string | null;
  type_source: Generated<"weekday" | "override">;
  status: Generated<DayPlanStatus>;
  frozen_at: TsNull;
  report_due_at: TsNull;
  finish_requested_at: TsNull;
  finish_requested_by: number | null;
  canceled_at: TsNull;
  canceled_by: number | null;
  ended_at: TsNull;
  setup_prompt_sent: Generated<boolean>;
  created_at: CreatedAt;
  updated_at: TsDefault;
}

export type InstanceState =
  | "scheduled"
  | "publishing"
  | "open"
  | "closing"
  | "closed"
  | "canceled"
  | "failed"
  | "uncertain"
  | "skipped";
export interface QuestionInstancesTable {
  id: Id;
  group_id: number;
  day_plan_id: number;
  slot: number;
  game_type: string;
  question_version_id: number | null;
  state: Generated<InstanceState>;
  publish_at: Ts;
  close_at: Ts;
  current_stage: Generated<number>;
  points: Json<{ correct: number; stages?: [number, number, number] }> | null;
  chat_id: number | null;
  message_id: number | null;
  poll_id: string | null;
  opened_at: TsNull;
  closed_at: TsNull;
  state_reason: string | null;
  delivery_confirmed: Generated<boolean>;
  results_finalized_at: TsNull;
  invalidated_at: TsNull;
  invalidated_by: number | null;
  updated_at: TsDefault;
}

export interface ClueStagesTable {
  instance_id: number;
  stage: number;
  scheduled_at: Ts;
  state: Generated<"scheduled" | "sending" | "sent" | "failed" | "uncertain" | "canceled">;
  sent_at: TsNull;
  message_id: number | null;
}

export type Verdict = "pending" | "correct" | "incorrect" | "needs_review";
export interface SubmissionsTable {
  id: Id;
  instance_id: number;
  group_id: number;
  student_id: number;
  stage: Generated<number>;
  kind: "poll" | "button" | "text";
  option_index: number | null;
  answer_text: string | null;
  received_at: Ts;
  verdict: Generated<Verdict>;
  graded_by: "deterministic" | "ai" | "admin" | null;
  grading_reason: string | null;
  graded_at: TsNull;
  created_at: CreatedAt;
}

export interface TextDraftsTable {
  instance_id: number;
  student_id: number;
  answer_text: string;
  received_at: Ts;
}

export interface AnswerSessionsTable {
  telegram_user_id: number;
  instance_id: number;
  student_id: number;
  started_at: Ts;
}

export interface GradingDecisionsTable {
  id: Id;
  submission_id: number;
  method: "deterministic" | "ai" | "admin" | "system";
  verdict: Verdict;
  reason: string | null;
  model: string | null;
  cache_key: string | null;
  actor_id: number | null;
  created_at: CreatedAt;
}

export interface AiGradeCacheTable {
  cache_key: string;
  verdict: Verdict;
  reason: string;
  model: string;
  created_at: CreatedAt;
}

export interface AnswerResultsTable {
  instance_id: number;
  student_id: number;
  group_id: number;
  local_date: LocalDate;
  status: Verdict;
  final_submission_id: number | null;
  stage: number | null;
  points: Generated<number>;
  updated_at: TsDefault;
}

export interface OrphanPollAnswersTable {
  id: Id;
  poll_id: string;
  user_id: number;
  option_ids: number[];
  received_at: Ts;
}

export interface ScoreLedgerTable {
  id: Id;
  group_id: number;
  student_id: number;
  points: number;
  kind: "answer" | "streak_bonus" | "adjustment" | "reversal";
  award_key: string;
  instance_id: number | null;
  local_date: LocalDate;
  week_start: LocalDate;
  reason: string | null;
  actor_id: number | null;
  reverses_id: number | null;
  created_at: CreatedAt;
}

export interface ScoreTotalsTable {
  group_id: number;
  student_id: number;
  period: "day" | "week" | "all";
  period_key: string;
  points: number;
}

export interface DailyParticipationTable {
  id: Id;
  group_id: number;
  student_id: number;
  local_date: LocalDate;
  status: "qualified" | "missed" | "neutral";
  opportunities: number;
  answered: number;
  computed_at: Ts;
  superseded_at: TsNull;
}

export interface StreakAwardsTable {
  id: Id;
  group_id: number;
  student_id: number;
  local_date: LocalDate;
  streak_length: number;
  ledger_id: number;
  revoked_at: TsNull;
  revoke_ledger_id: number | null;
}

export interface ReportsTable {
  id: Id;
  group_id: number;
  kind: "daily" | "weekly";
  period_key: LocalDate;
  status: Generated<"published" | "final">;
  has_pending: Generated<boolean>;
  parts: ColumnType<string[], string[] | undefined, string[]>;
  content_hash: string | null;
  needs_refresh: Generated<boolean>;
  published_at: TsDefault;
  last_edited_at: TsNull;
  finalized_at: TsNull;
}

export interface ReportMessagesTable {
  report_id: number;
  part: number;
  chat_id: number;
  message_id: number | null;
  text_hash: string | null;
}

export interface ChampionPeriodsTable {
  group_id: number;
  week_start: LocalDate;
  student_id: number;
  points: number;
  correct: number;
  status: "final" | "revoked";
  decided_at: Ts;
}

export type OutboxStatus = "pending" | "sending" | "sent" | "failed" | "uncertain" | "canceled";
export interface OutboxTable {
  id: Id;
  group_id: number | null;
  chat_id: number;
  method: string;
  payload: Json<Record<string, unknown>>;
  dedupe_key: string;
  purpose: string;
  ref_id: number | null;
  ref_part: number | null;
  status: Generated<OutboxStatus>;
  attempts: Generated<number>;
  next_attempt_at: TsDefault;
  lease_until: TsNull;
  last_error: string | null;
  result_message_id: number | null;
  result: Json<Record<string, unknown>> | null;
  created_at: CreatedAt;
  sent_at: TsNull;
}

export interface AiUsageTable {
  id: Id;
  group_id: number | null;
  purpose: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  ok: boolean;
  error: string | null;
  duration_ms: number | null;
  local_date: LocalDate;
  created_at: CreatedAt;
}

export interface AdminAlertsTable {
  alert_key: string;
  group_id: number | null;
  message: string;
  created_at: CreatedAt;
}

export interface WorkerHeartbeatsTable {
  worker: string;
  beat_at: Ts;
  info: Json<Record<string, unknown>>;
}

export interface DB {
  groups: GroupsTable;
  group_settings: GroupSettingsTable;
  telegram_users: TelegramUsersTable;
  students: StudentsTable;
  roster_entries: RosterEntriesTable;
  eligibility_intervals: EligibilityIntervalsTable;
  eligibility_events: EligibilityEventsTable;
  admin_sessions: AdminSessionsTable;
  audit_events: AuditEventsTable;
  materials: MaterialsTable;
  material_sections: MaterialSectionsTable;
  picture_assets: PictureAssetsTable;
  generation_batches: GenerationBatchesTable;
  questions: QuestionsTable;
  question_versions: QuestionVersionsTable;
  day_plans: DayPlansTable;
  question_instances: QuestionInstancesTable;
  clue_stages: ClueStagesTable;
  submissions: SubmissionsTable;
  text_drafts: TextDraftsTable;
  answer_sessions: AnswerSessionsTable;
  grading_decisions: GradingDecisionsTable;
  ai_grade_cache: AiGradeCacheTable;
  answer_results: AnswerResultsTable;
  orphan_poll_answers: OrphanPollAnswersTable;
  score_ledger: ScoreLedgerTable;
  score_totals: ScoreTotalsTable;
  daily_participation: DailyParticipationTable;
  streak_awards: StreakAwardsTable;
  reports: ReportsTable;
  report_messages: ReportMessagesTable;
  champion_periods: ChampionPeriodsTable;
  outbox: OutboxTable;
  ai_usage: AiUsageTable;
  admin_alerts: AdminAlertsTable;
  worker_heartbeats: WorkerHeartbeatsTable;
}

export type Row<T extends keyof DB> = Selectable<DB[T]>;
export type NewRow<T extends keyof DB> = Insertable<DB[T]>;
export type RowUpdate<T extends keyof DB> = Updateable<DB[T]>;
