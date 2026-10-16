-- Student game bot schema. All timestamps are UTC (timestamptz). Telegram ids are BIGINT
-- (Telegram ids can exceed 32 bits; the app parses them with an explicit safe-integer check).

create table groups (
  id              bigint generated always as identity primary key,
  chat_id         bigint not null unique,
  title           text not null default '',
  status          text not null default 'active' check (status in ('active', 'left', 'disabled')),
  bot_is_admin    boolean not null default false,
  member_count    integer,
  member_count_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table group_settings (
  group_id   bigint primary key references groups(id) on delete cascade,
  settings   jsonb not null,
  version    integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by bigint
);

-- Global Telegram identity (one row per Telegram user ever seen).
create table telegram_users (
  id                 bigint primary key,
  first_name         text not null default '',
  last_name          text,
  username           text,
  is_bot             boolean not null default false,
  private_chat_ready boolean not null default false,
  private_started_at timestamptz,
  updated_at         timestamptz not null default now()
);

-- A Telegram user's membership in one class group. Telegram id is authoritative; never merged by name.
create table students (
  id               bigint generated always as identity primary key,
  group_id         bigint not null references groups(id) on delete cascade,
  telegram_user_id bigint not null references telegram_users(id),
  status           text not null default 'eligible' check (status in ('eligible', 'blocked', 'archived')),
  membership       text not null default 'member' check (membership in ('member', 'left')),
  discovered_via   text not null,
  first_seen_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (group_id, telegram_user_id)
);
create index students_group_status_idx on students (group_id, status, membership);

-- The teacher's class list. Linking to a student is an explicit admin action.
create table roster_entries (
  id         bigint generated always as identity primary key,
  group_id   bigint not null references groups(id) on delete cascade,
  full_name  text not null,
  student_id bigint unique references students(id) on delete set null,
  archived   boolean not null default false,
  created_by bigint,
  created_at timestamptz not null default now()
);
create index roster_entries_group_idx on roster_entries (group_id, archived);

create table eligibility_intervals (
  id         bigint generated always as identity primary key,
  student_id bigint not null references students(id) on delete cascade,
  group_id   bigint not null references groups(id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz,
  check (ends_at is null or ends_at >= starts_at)
);
create unique index eligibility_one_open_idx on eligibility_intervals (student_id) where ends_at is null;
create index eligibility_group_idx on eligibility_intervals (group_id, starts_at);

create table eligibility_events (
  id             bigint generated always as identity primary key,
  student_id     bigint not null references students(id) on delete cascade,
  group_id       bigint not null references groups(id) on delete cascade,
  event          text not null,
  eligible_after boolean not null,
  actor_id       bigint,
  reason         text,
  at             timestamptz not null
);
create index eligibility_events_student_idx on eligibility_events (student_id, at);

create table admin_sessions (
  admin_telegram_id bigint primary key,
  group_id          bigint references groups(id) on delete set null,
  pending           jsonb,
  updated_at        timestamptz not null default now()
);

create table audit_events (
  id        bigint generated always as identity primary key,
  group_id  bigint references groups(id) on delete cascade,
  actor_id  bigint,
  action    text not null,
  details   jsonb not null default '{}'::jsonb,
  at        timestamptz not null default now()
);
create index audit_events_group_idx on audit_events (group_id, at desc);

-- ---------------------------------------------------------------- materials

create table materials (
  id                bigint generated always as identity primary key,
  group_id          bigint not null references groups(id) on delete cascade,
  title             text not null,
  kind              text not null check (kind in ('text', 'txt', 'md', 'pdf', 'docx', 'image')),
  file_name         text,
  mime              text,
  size_bytes        integer,
  telegram_file_id  text,
  raw_bytes         bytea,
  file_hash         text,
  content_hash      text,
  status            text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed', 'deleted')),
  error             text,
  page_count        integer,
  extraction_method text,
  quality           real,
  active            boolean not null default true,
  created_by        bigint,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz
);
create index materials_group_idx on materials (group_id, status, active);
create index materials_hash_idx on materials (group_id, file_hash);

create table material_sections (
  id          bigint generated always as identity primary key,
  material_id bigint not null references materials(id) on delete cascade,
  idx         integer not null,
  ref         text not null,
  text        text not null,
  unique (material_id, idx)
);

create table picture_assets (
  id               bigint generated always as identity primary key,
  group_id         bigint not null references groups(id) on delete cascade,
  telegram_file_id text not null,
  file_unique_id   text,
  description      text not null,
  status           text not null default 'pending_review'
                   check (status in ('pending_review', 'approved', 'rejected')),
  review           jsonb,
  uploaded_by      bigint,
  created_at       timestamptz not null default now()
);
create index picture_assets_group_idx on picture_assets (group_id, status);

-- ---------------------------------------------------------------- questions

create table generation_batches (
  id              bigint generated always as identity primary key,
  group_id        bigint not null references groups(id) on delete cascade,
  game_type       text not null,
  language        text not null,
  topic           text not null default '',
  level           text not null default '',
  requested_count integer not null,
  source_count    integer not null,
  extra_count     integer not null,
  difficulty_plan jsonb not null,
  material_ids    bigint[] not null default '{}',
  input_hash      text not null,
  status          text not null default 'queued'
                  check (status in ('queued', 'generating', 'reviewing', 'done', 'failed', 'partial')),
  error           text,
  attempts        integer not null default 0,
  target_date     date,
  created_by      bigint,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index generation_batches_group_idx on generation_batches (group_id, status, game_type);

create table questions (
  id                 bigint generated always as identity primary key,
  group_id           bigint not null references groups(id) on delete cascade,
  game_type          text not null,
  origin             text not null check (origin in ('source', 'extra')),
  batch_id           bigint references generation_batches(id) on delete set null,
  current_version_id bigint,
  created_at         timestamptz not null default now()
);

create table question_versions (
  id                bigint generated always as identity primary key,
  question_id       bigint not null references questions(id) on delete cascade,
  group_id          bigint not null references groups(id) on delete cascade,
  version           integer not null,
  game_type         text not null,
  language          text not null,
  difficulty        text not null check (difficulty in ('easy', 'medium', 'hard')),
  origin            text not null check (origin in ('source', 'extra')),
  content           jsonb not null,
  source_refs       jsonb not null default '[]'::jsonb,
  source_excerpt    text not null default '',
  content_hash      text not null,
  search_text       text not null,
  review_status     text not null default 'draft'
                    check (review_status in ('draft', 'validated', 'ai_rejected', 'approved', 'rejected', 'superseded')),
  validation_errors jsonb not null default '[]'::jsonb,
  ai_review         jsonb,
  attempt           integer not null default 1,
  approved_by       bigint,
  approved_at       timestamptz,
  rejected_reason   text,
  published_at      timestamptz,
  created_at        timestamptz not null default now(),
  unique (question_id, version)
);
create index question_versions_bank_idx on question_versions (group_id, game_type, review_status);
create index question_versions_hash_idx on question_versions (group_id, content_hash);
alter table questions add constraint questions_current_version_fk
  foreign key (current_version_id) references question_versions(id) on delete set null;

-- Published question versions are immutable: corrections create a new version.
create function forbid_published_version_edit() returns trigger language plpgsql as $$
begin
  if old.published_at is not null and (
       new.content is distinct from old.content
    or new.game_type is distinct from old.game_type
    or new.difficulty is distinct from old.difficulty
    or new.source_refs is distinct from old.source_refs
    or new.source_excerpt is distinct from old.source_excerpt) then
    raise exception 'question_version % is published and immutable', old.id;
  end if;
  return new;
end $$;
create trigger question_versions_immutable before update on question_versions
  for each row execute function forbid_published_version_edit();

-- ---------------------------------------------------------------- game days

create table day_plans (
  id                  bigint generated always as identity primary key,
  group_id            bigint not null references groups(id) on delete cascade,
  local_date          date not null,
  game_type           text,
  type_source         text not null default 'weekday' check (type_source in ('weekday', 'override')),
  status              text not null default 'planned'
                      check (status in ('planned', 'active', 'finishing', 'finished', 'canceled', 'off')),
  frozen_at           timestamptz,
  report_due_at       timestamptz,
  finish_requested_at timestamptz,
  finish_requested_by bigint,
  canceled_at         timestamptz,
  canceled_by         bigint,
  ended_at            timestamptz,
  setup_prompt_sent   boolean not null default false,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (group_id, local_date)
);
create index day_plans_due_idx on day_plans (status, report_due_at);

create table question_instances (
  id                  bigint generated always as identity primary key,
  group_id            bigint not null references groups(id) on delete cascade,
  day_plan_id         bigint not null references day_plans(id) on delete cascade,
  slot                integer not null,
  game_type           text not null,
  question_version_id bigint references question_versions(id),
  state               text not null default 'scheduled'
                      check (state in ('scheduled', 'publishing', 'open', 'closing', 'closed',
                                       'canceled', 'failed', 'uncertain', 'skipped')),
  publish_at          timestamptz not null,
  close_at            timestamptz not null,
  current_stage       integer not null default 1,
  points              jsonb,
  chat_id             bigint,
  message_id          integer,
  poll_id             text unique,
  opened_at           timestamptz,
  closed_at           timestamptz,
  state_reason        text,
  delivery_confirmed  boolean not null default false,
  results_finalized_at timestamptz,
  invalidated_at      timestamptz,
  invalidated_by      bigint,
  updated_at          timestamptz not null default now(),
  unique (day_plan_id, slot)
);
create index question_instances_publish_idx on question_instances (state, publish_at);
create index question_instances_close_idx on question_instances (state, close_at);
create index question_instances_version_idx on question_instances (group_id, question_version_id);

create table clue_stages (
  instance_id  bigint not null references question_instances(id) on delete cascade,
  stage        integer not null check (stage between 2 and 3),
  scheduled_at timestamptz not null,
  state        text not null default 'scheduled'
               check (state in ('scheduled', 'sending', 'sent', 'failed', 'uncertain', 'canceled')),
  sent_at      timestamptz,
  message_id   integer,
  primary key (instance_id, stage)
);
create index clue_stages_due_idx on clue_stages (state, scheduled_at);

-- ---------------------------------------------------------------- answers

create table submissions (
  id              bigint generated always as identity primary key,
  instance_id     bigint not null references question_instances(id) on delete cascade,
  group_id        bigint not null references groups(id) on delete cascade,
  student_id      bigint not null references students(id) on delete cascade,
  stage           integer not null default 1,
  kind            text not null check (kind in ('poll', 'button', 'text')),
  option_index    integer,
  answer_text     text,
  received_at     timestamptz not null,
  verdict         text not null default 'pending'
                  check (verdict in ('pending', 'correct', 'incorrect', 'needs_review')),
  graded_by       text check (graded_by in ('deterministic', 'ai', 'admin')),
  grading_reason  text,
  graded_at       timestamptz,
  created_at      timestamptz not null default now(),
  -- One final answer per student per question (per clue stage for guess-the-word). The first insert wins.
  unique (instance_id, student_id, stage)
);
create index submissions_student_idx on submissions (group_id, student_id);
create index submissions_verdict_idx on submissions (group_id, verdict);

create table text_drafts (
  instance_id bigint not null references question_instances(id) on delete cascade,
  student_id  bigint not null references students(id) on delete cascade,
  answer_text text not null,
  received_at timestamptz not null,
  primary key (instance_id, student_id)
);

-- Which question a student is answering in the private chat (set by the deep-link button).
create table answer_sessions (
  telegram_user_id bigint primary key,
  instance_id      bigint not null references question_instances(id) on delete cascade,
  student_id       bigint not null references students(id) on delete cascade,
  started_at       timestamptz not null
);

-- Append-only grading history (deterministic, AI and admin decisions).
create table grading_decisions (
  id            bigint generated always as identity primary key,
  submission_id bigint not null references submissions(id) on delete cascade,
  method        text not null check (method in ('deterministic', 'ai', 'admin', 'system')),
  verdict       text not null check (verdict in ('pending', 'correct', 'incorrect', 'needs_review')),
  reason        text,
  model         text,
  cache_key     text,
  actor_id      bigint,
  created_at    timestamptz not null default now()
);
create index grading_decisions_submission_idx on grading_decisions (submission_id);

create table ai_grade_cache (
  cache_key  text primary key,
  verdict    text not null,
  reason     text not null,
  model      text not null,
  created_at timestamptz not null default now()
);

-- One derived outcome per student per question.
create table answer_results (
  instance_id         bigint not null references question_instances(id) on delete cascade,
  student_id          bigint not null references students(id) on delete cascade,
  group_id            bigint not null references groups(id) on delete cascade,
  local_date          date not null,
  status              text not null check (status in ('pending', 'correct', 'incorrect', 'needs_review')),
  final_submission_id bigint references submissions(id),
  stage               integer,
  points              integer not null default 0,
  updated_at          timestamptz not null default now(),
  primary key (instance_id, student_id)
);
create index answer_results_day_idx on answer_results (group_id, local_date);

-- Polls answered while a poll's delivery was uncertain (we did not get its poll_id).
create table orphan_poll_answers (
  id          bigint generated always as identity primary key,
  poll_id     text not null,
  user_id     bigint not null,
  option_ids  integer[] not null,
  received_at timestamptz not null,
  unique (poll_id, user_id)
);

-- ---------------------------------------------------------------- points

create table score_ledger (
  id          bigint generated always as identity primary key,
  group_id    bigint not null references groups(id) on delete cascade,
  student_id  bigint not null references students(id) on delete cascade,
  points      integer not null,
  kind        text not null check (kind in ('answer', 'streak_bonus', 'adjustment', 'reversal')),
  -- Idempotency key: duplicate updates, retries, crashes or report reruns can never award twice.
  award_key   text not null unique,
  instance_id bigint references question_instances(id),
  local_date  date not null,
  week_start  date not null,
  reason      text,
  actor_id    bigint,
  reverses_id bigint references score_ledger(id),
  created_at  timestamptz not null default now()
);
create index score_ledger_student_idx on score_ledger (group_id, student_id, local_date);

create table score_totals (
  group_id   bigint not null references groups(id) on delete cascade,
  student_id bigint not null references students(id) on delete cascade,
  period     text not null check (period in ('day', 'week', 'all')),
  period_key text not null,
  points     integer not null default 0,
  primary key (group_id, student_id, period, period_key)
);
create index score_totals_period_idx on score_totals (group_id, period, period_key);

create function score_ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'score_ledger is append-only; add an adjustment or reversal entry instead';
end $$;
create trigger score_ledger_no_update before update or delete on score_ledger
  for each statement when (pg_trigger_depth() = 0) execute function score_ledger_append_only();

-- Cached totals are maintained in the same transaction as the ledger insert.
create function score_ledger_totals() returns trigger language plpgsql as $$
begin
  insert into score_totals (group_id, student_id, period, period_key, points) values
    (new.group_id, new.student_id, 'day', new.local_date::text, new.points),
    (new.group_id, new.student_id, 'week', new.week_start::text, new.points),
    (new.group_id, new.student_id, 'all', 'all', new.points)
  on conflict (group_id, student_id, period, period_key)
  do update set points = score_totals.points + excluded.points;
  return new;
end $$;
create trigger score_ledger_totals_trg after insert on score_ledger
  for each row execute function score_ledger_totals();

-- Immutable participation records: a recalculation supersedes the old row instead of editing it.
create table daily_participation (
  id            bigint generated always as identity primary key,
  group_id      bigint not null references groups(id) on delete cascade,
  student_id    bigint not null references students(id) on delete cascade,
  local_date    date not null,
  status        text not null check (status in ('qualified', 'missed', 'neutral')),
  opportunities integer not null,
  answered      integer not null,
  computed_at   timestamptz not null,
  superseded_at timestamptz
);
create unique index daily_participation_current_idx
  on daily_participation (group_id, student_id, local_date) where superseded_at is null;

create table streak_awards (
  id            bigint generated always as identity primary key,
  group_id      bigint not null references groups(id) on delete cascade,
  student_id    bigint not null references students(id) on delete cascade,
  local_date    date not null,
  streak_length integer not null,
  ledger_id     bigint not null references score_ledger(id),
  revoked_at    timestamptz,
  revoke_ledger_id bigint references score_ledger(id)
);
create unique index streak_awards_active_idx on streak_awards (group_id, student_id, local_date) where revoked_at is null;

-- ---------------------------------------------------------------- reports

create table reports (
  id             bigint generated always as identity primary key,
  group_id       bigint not null references groups(id) on delete cascade,
  kind           text not null check (kind in ('daily', 'weekly')),
  period_key     date not null,
  status         text not null default 'published' check (status in ('published', 'final')),
  has_pending    boolean not null default false,
  parts          text[] not null default '{}',
  content_hash   text,
  needs_refresh  boolean not null default false,
  published_at   timestamptz not null default now(),
  last_edited_at timestamptz,
  finalized_at   timestamptz,
  -- One logical report per group/day (and per group/week). Never a second one.
  unique (group_id, kind, period_key)
);
create index reports_refresh_idx on reports (needs_refresh) where needs_refresh;

create table report_messages (
  report_id  bigint not null references reports(id) on delete cascade,
  part       integer not null,
  chat_id    bigint not null,
  message_id integer,
  text_hash  text,
  primary key (report_id, part)
);

create table champion_periods (
  group_id   bigint not null references groups(id) on delete cascade,
  week_start date not null,
  student_id bigint not null references students(id) on delete cascade,
  points     integer not null,
  correct    integer not null,
  status     text not null check (status in ('final', 'revoked')),
  decided_at timestamptz not null,
  primary key (group_id, week_start, student_id)
);

-- ---------------------------------------------------------------- delivery & ops

-- Telegram send intentions. A row is sent at most once automatically; ambiguous failures become
-- 'uncertain' and wait for an admin decision instead of a blind resend.
create table outbox (
  id                bigint generated always as identity primary key,
  group_id          bigint references groups(id) on delete cascade,
  chat_id           bigint not null,
  method            text not null,
  payload           jsonb not null,
  dedupe_key        text not null unique,
  purpose           text not null,
  ref_id            bigint,
  ref_part          integer,
  status            text not null default 'pending'
                    check (status in ('pending', 'sending', 'sent', 'failed', 'uncertain', 'canceled')),
  attempts          integer not null default 0,
  next_attempt_at   timestamptz not null default now(),
  lease_until       timestamptz,
  last_error        text,
  result_message_id integer,
  result            jsonb,
  created_at        timestamptz not null default now(),
  sent_at           timestamptz
);
create index outbox_due_idx on outbox (status, next_attempt_at);

create table ai_usage (
  id            bigint generated always as identity primary key,
  group_id      bigint references groups(id) on delete cascade,
  purpose       text not null,
  model         text not null,
  input_tokens  integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd      numeric(12, 6) not null default 0,
  ok            boolean not null,
  error         text,
  duration_ms   integer,
  local_date    date not null,
  created_at    timestamptz not null default now()
);
create index ai_usage_day_idx on ai_usage (group_id, local_date);

-- Alerts already sent (de-duplicates repeated admin notifications).
create table admin_alerts (
  alert_key  text primary key,
  group_id   bigint references groups(id) on delete cascade,
  message    text not null,
  created_at timestamptz not null default now()
);

create table worker_heartbeats (
  worker     text primary key,
  beat_at    timestamptz not null,
  info       jsonb not null default '{}'::jsonb
);
