# Student Game Bot (Telegram)

Learning games for a Telegram class group. The teacher uploads lesson material, AI drafts and reviews questions,
the teacher approves them, and the bot runs **one game type per day** during the configured hours, checks answers,
keeps points in an append-only ledger and posts **one daily report** plus a **weekly report** with the champion(s).

Six game types only: quiz poll, find the mistake, guess the word, true or false, picture quiz, emoji puzzle.
There is no `/score`, `/top`, `/join`, pause, team, voting or friend feature, and no points for chatting.
Students never receive unsolicited private messages.

---

## 1. Architecture (one project, one process + PostgreSQL)

```
src/
  domain/      pure rules: settings, schedule validation, 80/20 split, points, streaks, ranking, normalization,
               question schemas + deterministic validation, report rendering, Telegram limits
  games/       the six engines: render question, close actions, reveal, deterministic grading
  services/    planner (day plans), runner (publish / clues / close), submissions (answer intake),
               scoring (ledger), grading, participation (streaks), reports, roster, materials,
               generation (AI pipeline), questionBank, outbox (Telegram delivery), alerts
  ai/          provider interface, OpenAI adapter (gpt-6-luna, default), Anthropic adapter, prompts, schemas,
               budget, mock (demo/test only)
  documents/   content-based file detection, TXT/MD/PDF/DOCX extraction, sections, OCR
  telegram/    port interface, real adapter (node-telegram-bot-api v2), signed callback data, fake
  bot/         update router, admin panel (private chat)
  jobs/        pg-boss queue (+ in-process queue for tests/simulation)
  app/         wiring, scheduler tick, HTTP (webhook, /healthz, /metrics)
  cli/         migrate, seed, simulate, loadtest, eval:grading
```

* **Truth lives in PostgreSQL.** Day plans, question instances, clue stages, polls, submissions, grading decisions,
  ledger, participation, reports and every send intention (outbox) are rows. A scheduler tick (every second) claims
  due work with `FOR UPDATE SKIP LOCKED` + compare-and-set state changes, so restarts and several workers are safe.
  No `setTimeout` or in-memory list is a source of truth.
* **Background work** (document extraction, OCR, generation, AI review, AI grading, picture review, bank preparation)
  runs in **pg-boss 12** queues (PostgreSQL-backed; no Redis) with per-queue concurrency, exponential backoff with
  jitter, bounded retries and a dead-letter queue that alerts the admin. Jobs are enqueued inside the same DB
  transaction as the data that needs them.
* **Question instance lifecycle:** `scheduled → publishing → open → closing → closed`, plus `canceled`, `failed`,
  `uncertain`, `skipped`. Question **versions** have their own review lifecycle:
  `draft → validated (AI-reviewed) → approved` (or `ai_rejected` / `rejected`). A published version is immutable
  (database trigger). Grading state is separate (`submissions.verdict`).
* **Answer path** (no AI, no network except the callback acknowledgement): one transaction with deterministic checks.

### Verified against current documentation / installed packages (2026-10)
* Telegram Bot API **10.3**: `sendPoll` takes `correct_option_ids` (array), 1–12 options, question ≤ 300, option ≤ 100,
  explanation ≤ 200, `allows_revoting` defaults to false for quizzes, `hide_results_until_closes`, `open_period` up to
  2 628 000 s; `callback_data` 1–64 bytes; message 4096 / caption 1024; `answerCallbackQuery` text ≤ 200;
  `chat_member` updates must be requested explicitly and need bot admin rights; webhook secret header
  `X-Telegram-Bot-Api-Secret-Token`; `getFile` ≤ 20 MB; deep-link start parameter ≤ 64 base64url chars.
* **node-telegram-bot-api 2.1.0** is a from-scratch v2 (ESM + CJS, typed `Api`, `longPoll`, structured errors).
  Its transport retries timeouts by default — we create it with `maxRetries: 0` so a send is never blindly repeated.
* **pg-boss 12.38** (named export `PgBoss`, `createQueue` with `retryBackoff`, `retryDelayMax`, `deadLetter`,
  `localConcurrency`, `fromKysely` for transactional inserts).
* **OpenAI (default provider)** via `openai` 7.34, Responses API: **`gpt-6-luna`** (released 2026-09-22) is the
  default for generation, review, grading and picture checks. Per developers.openai.com: Responses API, structured
  outputs, image input, reasoning effort `none|low|medium|high|xhigh|max`, 1.05M context, 128K output,
  $0.10 / $0.50 per 1M input/output tokens. Requests use `text.format` strict JSON schema (`zodTextFormat`),
  `reasoning.effort`, `store: false`; refusals and `incomplete` responses are permanent errors.
* **Claude API** (optional, `AI_PROVIDER=anthropic`) via `@anthropic-ai/sdk` 0.134: `claude-opus-5-5` default, `claude-sonnet-5-5`, `claude-haiku-5-5`; structured outputs through `output_config.format`
  (`betaZodOutputFormat`), `output_config.effort`, refusal handling (`stop_reason: "refusal"`) and the server-side
  refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).

---

## 2. Local development on Windows

Requirements: Node.js ≥ 22.12 (tested with 24.16), Git Bash or PowerShell. No Docker needed.

```bash
npm ci                       # npm 12 asks to approve install scripts: esbuild, @embedded-postgres/windows-x64
npm run db:local             # terminal 1: real PostgreSQL 17 on localhost:54340 (data in .data/pg)
cp .env.example .env         # then fill BOT_TOKEN, BOT_ADMIN_IDS, CALLBACK_SECRET, OPENAI_API_KEY
npm run migrate
npm run dev                  # terminal 2: long polling (TELEGRAM_MODE=polling)
```

`npm run db:local` creates the databases `gamebot` and `gamebot_test` (user/password `gamebot`).
Without an AI key you can try everything with `APP_MODE=demo AI_PROVIDER=mock` (deterministic sample questions —
never use the mock in production; the config refuses it there).

## 3. Deploy on Railway (bot + PostgreSQL)

The project is described in `.railway/railway.ts` (Railway *Infrastructure as Code*; the older `railway.json` is
deprecated — new services cannot use it and existing files stop being read on 2026-12-01). It creates:

* **`postgres`** — Railway PostgreSQL (private by default),
* **`bot`** — built from the `Dockerfile`, one instance in `europe-west4`, health check `GET /healthz`,
  restart on failure, `DATABASE_URL` wired to the private Postgres URL, `TELEGRAM_MODE=webhook`,
  `AI_PROVIDER=openai` (model `gpt-6-luna`).

**One-time setup**

```bash
npm i -g @railway/cli          # needs CLI >= 5.42.1 (the IaC engine ships in the CLI)
railway login
cd TelegramBot
railway config plan            # read-only preview of what will be created
railway config apply           # creates the project, Postgres and the bot service
```

1. **Secrets** — Railway dashboard → `bot` → *Variables* (they are `preserve()`d in the file, never committed):
   `BOT_TOKEN`, `BOT_ADMIN_IDS`, `OPENAI_API_KEY`, `CALLBACK_SECRET` (random, ≥ 16 chars) and `WEBHOOK_SECRET`
   (16–256 chars of `A-Z a-z 0-9 _ -`). Until they are set the bot exits with a message naming what is missing.
2. **Public domain** — `bot` → *Settings → Networking → Generate Domain* (or `railway domain`). Railway then injects
   `RAILWAY_PUBLIC_DOMAIN`; the bot uses `https://<that domain>/telegram/webhook` and registers the webhook itself.
   The app listens on Railway's `PORT` automatically.
3. **Deploy the code** — either connect GitHub (push this folder to a private repo, then run
   `GITHUB_REPO=you/repo railway config apply` once; every push to `main` deploys), or deploy this folder directly:
   `railway up --service bot`. `.env`, `.data`, `node_modules` are not uploaded (`.gitignore` / `.dockerignore`).
4. On start the bot applies the database migrations (advisory lock, safe during overlapping deploys), starts the
   webhook, scheduler and job workers. Check `railway logs --service bot` and `https://<domain>/healthz`.

**Notes**

* Use **webhook** mode on Railway. During a deploy the old and new instance overlap for ~15 s; two long-polling
  consumers would get `409 Conflict` (the bot logs a warning if it sees polling on Railway). Publishing, closing
  and sending stay correct during the overlap (row locks + compare-and-set + outbox).
* **Do not run `npm run dev` locally with the production bot token** while Railway is live: polling mode deletes the
  webhook, which disconnects the Railway bot until it restarts. Create a second test bot in @BotFather for local work.
* Inside Railway the bot uses the private `DATABASE_URL` (`postgres.railway.internal`, no TLS settings needed).
* **From your PC** (migrations, `npm run db:check`, `npm run seed`, `pg_dump`): enable *Public Networking* on the
  Postgres service and use its `DATABASE_PUBLIC_URL` (`*.proxy.rlwy.net`) with `?sslmode=require`; the app treats that
  as "encrypted, certificate not verified" because Railway's Postgres image uses generated self-signed certificates.
  Proxy traffic is billed as egress — turn public networking off when you are done.
* **Backups**: enable Railway volume backups for the Postgres service, and/or
  `pg_dump "$DATABASE_PUBLIC_URL" -Fc -f gamebot.dump` (restore: `pg_restore -d "$DATABASE_PUBLIC_URL" --clean
  --if-exists gamebot.dump`). Uploaded lesson files live in the database too.
* Never point `npm test` / `simulate` / `loadtest` at the Railway database: they wipe data and refuse database
  names that do not end in `_test` / `_sim` (Railway's default name is `railway`).
* The scheduler queries the database every second, so the bot and Postgres run continuously — budget for always-on
  usage in your Railway plan (do not enable app sleeping: it would stop the game timers).

**Other hosts.** Any PostgreSQL works. Neon is also supported: use the pooled string as `DATABASE_URL` and the
direct one as `DATABASE_DIRECT_URL` (migrations and pg-boss need session-level advisory locks); Neon's
`sslmode=require&channel_binding=require` are mapped to verified TLS + channel binding.

## 4. Other deployment: VPS with Docker Compose

With a local PostgreSQL container on your own server:

```bash
git clone <repo> && cd <repo>
cp .env.example .env    # APP_MODE=production, TELEGRAM_MODE=webhook, WEBHOOK_URL=https://bot.example.com,
                        # WEBHOOK_SECRET, CALLBACK_SECRET, POSTGRES_PASSWORD, BOT_TOKEN, BOT_ADMIN_IDS, OPENAI_API_KEY
docker compose up -d --build
docker compose logs -f bot
```

The bot listens on `127.0.0.1:8080`. Put TLS in front, e.g. Caddy (`/etc/caddy/Caddyfile`):

```
bot.example.com {
  reverse_proxy /telegram/* 127.0.0.1:8080
}
```

On start the bot runs migrations and registers the webhook (`setWebhook` with the secret token and the needed
`allowed_updates`). Polling and webhook are never active together: polling mode deletes the webhook first.
For local polling stop the VPS bot first (Telegram allows only one consumer per token).

Without Docker: install Node 24 + PostgreSQL 17, `npm ci && npm run build`, run `node dist/src/main.js` under
systemd (`Restart=always`, `EnvironmentFile=.env`, `KillSignal=SIGTERM` — shutdown is graceful).

**Backups (local PostgreSQL container)**

```bash
docker compose exec db pg_dump -U gamebot -Fc gamebot > backups/gamebot-$(date +%F).dump      # daily (cron)
docker compose exec -T db pg_restore -U gamebot -d gamebot --clean --if-exists < backups/gamebot-2026-10-16.dump
```

Uploaded files are stored in the database (raw bytes are dropped after `RAW_FILE_RETENTION_DAYS`), so the dump is
the whole state. pg-boss tables live in the `pgboss` schema of the same database.

**Health / metrics:** `GET /healthz` (DB + scheduler heartbeat), `GET /metrics` (Prometheus text: sends, send
failures by kind, outbox rows by status, oldest pending outbox age = queue delay, AI requests and cost, answers,
scheduler errors). Logs are JSON (pino) and never contain tokens or answer text.

---

## 5. First-time setup (teacher)

1. **@BotFather**: create the bot, copy the token to `BOT_TOKEN`. Put your numeric Telegram id (e.g. from
   @userinfobot) into `BOT_ADMIN_IDS`. Start the bot privately once (`/start`) so it may message you.
2. **Add the bot to the class group and make it an administrator** (needed to see joins/leaves via `chat_member`
   updates and to verify members with `getChatMember`). The bot alerts you privately when it joins.
   Privacy mode can stay on; with it off the bot can also discover members from ordinary messages (never scored).
3. Open the private chat and send **/admin**. Buttons: Guruhlar, O'quvchilar, Materiallar, Savollar, Jadval,
   O'yin turlari, Ballar, Hisobotlar, AI sozlamalari, Bugungi o'yinlarni to'xtatish. Every saved change replies
   with "✅ Saqlandi — <group>: …".
4. **Roster:** *O'quvchilar → Sinf ro'yxatini kiritish* (one full name per line). Telegram has no endpoint that
   lists all existing members, so students are discovered when they join, answer, press a button or start the bot.
   Link names to discovered members explicitly (*O'quvchilar ro'yxati → student → Ro'yxatdagi ismga bog'lash*);
   names are never matched automatically. The screen shows roster completeness. Use *Shaxsiy chat tugmasi* to post
   a "start the bot" button in the group (needed for find-the-mistake and guess-the-word answers).
5. **Schedule:** *Jadval* (days, start/end, questions per day, answer time, spacing, timezone, weekly report time).
   Impossible schedules are rejected with an explanation (e.g. "6 ta savol sig'maydi … ko'pi bilan 5 ta").
   Overnight windows are not supported in this version.
6. **Game types:** *O'yin turlari* (Mon quiz, Tue find the mistake, Wed guess the word, Thu true/false, Fri picture,
   Sat emoji, Sun report only — all editable). Today's/tomorrow's type can be changed until the first question goes out.
7. **First lesson:** *Materiallar → Matn qo'shish / Fayl yuklash* (TXT, MD, text PDF, DOCX; OCR for scans when
   `OCR_ENABLED=true`). Set *Mavzu* and *Daraja*. For picture days upload pictures (*Savollar → Rasmlar*) with a
   caption describing them — only pictures you made or may use.
8. **Questions:** *Savollar → Savol yaratish* (or wait: the bot prepares tomorrow's bank automatically and
   asks you). Review each in *Tasdiqlash*: origin (📗 lesson / 🌐 extra), source reference and excerpt, answer,
   AI-review notes. Nothing unapproved is ever published unless you switch on auto-approval in *AI sozlamalari*.

---

## 6. Game and scoring rules (as implemented)

* One game type per group per local day, frozen when the first question is published. Settings changes later only
  re-time **unpublished** slots (same slot ids); published deadlines never move.
* **Polls (quiz, true/false):** non-anonymous quiz polls; first non-empty vote is locked by a unique constraint;
  retractions/re-votes/duplicate updates never score twice. The explanation is posted **after** closing, not in the
  poll. **Telegram's quiz UI shows each voter whether they were right** — correctness cannot be hidden for quiz
  polls. The optional `hide_results_until_closes` (admin toggle, **off by default** because it was verified from the
  docs only, not against live Telegram) would hide the vote tallies until closing.
* **Buttons (picture, emoji):** same keyboard for everyone, signed callback data, first press final, private toast
  acknowledgement that never reveals correctness, buttons removed at closing.
* **Text games:** deep-link button → private chat. Find the mistake: draft → "Yuborish" confirmation locks the
  answer (confirmation time must beat the deadline). Guess the word: one guess per clue stage; reward by the
  **server receipt stage** (15/10/5); the earliest correct stage wins even if its AI verdict arrives later.
* **Grading:** deterministic first (options, accepted variants, Uzbek apostrophe and Cyrillic/Latin forms,
  insignificant code whitespace/quotes). AI only for remaining free text; the model returns a verdict, never points.
  AI failures, budget exhaustion and ambiguity → *needs review* (pending), never "wrong". Admin corrections need a
  reason and append ledger adjustments. Student code is never executed.
* **Points:** easy 5 / medium 10 / hard 15, true/false 5, emoji 5, guess stages 15/10/5; no negatives, no speed bonus.
  Append-only ledger with unique award keys; totals per day/week/all-time maintained by a trigger.
* **Streaks:** a scheduled game day counts when the student submitted at least one timely answer to a valid question
  (even wrong/pending). Neutral: days off, canceled days, days without delivered questions, days the student was
  ineligible. +10 at 5, 10, 15… days. Recalculated with audited reversals if a question is invalidated.
* **Reports:** one logical daily report per group/day (DB unique key), all currently eligible discovered students
  including zero scorers, pending marked; corrections edit the same messages; large rosters split into numbered parts.
  Weekly (Mon 00:00 – Mon 00:00 local): after the week's last daily report, at the configured time (default Sunday
  18:00); ties on points and correct answers share rank and title; provisional until pending answers settle.
* **Stop Today:** active question canceled (no points, not counted), the rest canceled, earlier results kept; the
  report still goes out at the end — or immediately with *Yakunlash va hozir hisobot*.

## 7. Delivery guarantees (honest version)

Scoring is exactly-once inside the database. **External delivery is not exactly-once**: a Telegram request can time
out after Telegram accepted it. Every send goes through the outbox and is attempted automatically **at most once**
unless the failure proves it was not delivered (DNS/connection refused, 429 with `retry_after`). Ambiguous failures
become **uncertain** and the admin decides in *Hisobotlar → Noaniq yuborishlar* (mark delivered / resend — may
duplicate / cancel). Uncertain polls are recovered automatically when Telegram sends a `poll` update with the same
question; votes that arrived meanwhile are applied. An uncertain question that is never confirmed is excluded from
"unanswered" counts. Incoming updates are processed at least once (polling offset advances only after the batch);
handlers are idempotent.

---

## 8. Testing

```bash
npm run db:local            # PostgreSQL for the integration tests (gamebot_test)
npm test                    # 116 tests: unit + integration against real PostgreSQL, Telegram & AI mocked
npm run typecheck
npm run simulate -- --days 1    # one full game day in seconds (fake Telegram, mock AI, virtual clock)
npm run simulate -- --days 7    # Monday..Sunday incl. weekly report, blocked/departed students, AI timeout, admin fixes
npm run loadtest                # 100 students answering one question at the same time
npm run eval:grading            # AI grading evaluation with the configured model, gpt-6-luna by default (costs money)
npm run db:check                # read-only database check (safe against the Railway database)
npm run ocr:check               # downloads tesseract data once, OCRs a rendered image and PDF
```

Integration coverage: one type per day + freezing, invalid schedules, bot-admin-only actions (incl. forged admin
buttons), automatic eligibility, no student score/top/join/pause, all six games, document extraction + rejected
files (exe, macro DOCX, legacy .doc, scanned PDF without OCR, oversize), 80/20 rounding, approval gates and
auto-publish, bounded regeneration, no recent duplicates, first-answer locking, late answers, stage rewards, delayed
earlier-stage AI verdicts, duplicate/concurrent poll updates, blocked/departed students, cross-group isolation,
atomic awards, crash recovery (stale `sending` rows), downtime (stale slots skipped, overdue questions closed with
original deadlines, missing report produced once), AI timeout → pending, prompt injection, one report incl. zero
scorers, report split + correction edits, Stop Today / Finish and Report, weekly Monday boundary and shared titles,
neutral canceled days, streak bonuses not duplicated and revoked on invalidation, uncertain sends (no blind resend,
poll-update recovery, admin resend), pg-boss transactional enqueue + dead letter, webhook secret, health/metrics,
OpenAI and Anthropic adapters through their real SDKs with faked HTTP (request shape, strict schema, refusals,
truncation, error mapping), Railway PORT/domain/TLS handling, Neon pooled/direct rule.

**Load test (this machine, local PostgreSQL 17, fake Telegram — network and AI time excluded):** 100 students +
10 duplicate deliveries on one question → 100 submissions, 25 ledger rows (25 % correct), no double awards.
Sequential cost ≈ 4–5 ms per answer (one transaction). With 4 concurrent lanes and a 10-connection pool:
110 updates in ~240–310 ms, p95 ≈ 13–15 ms; 16 lanes only added pool queueing (p95 ≈ 80–180 ms), so the default
is 4. Real acknowledgement time adds the Telegram round trip (not measured here).

**Grading evaluation:** `data/grading-eval.json` has 28 cases (correct, wrong, near miss, equivalent code,
ambiguous, multilingual, prompt injection). It was run here only with the **mock** provider (no API key available):
exact/variant/apostrophe/Cyrillic cases and injections are handled deterministically or rejected; the mock fails
some equivalent-code cases by design. **Run it with your real key before production and before choosing a cheaper
grading model**; the CLI saves a JSON report and exits non-zero on any false "correct".

## 9. Known limitations / not verified here

* **Not run against live Telegram** (no bot token in this environment), **not against the live OpenAI/Claude APIs**
  (no API keys) and **not deployed to Railway** (no account access here; `railway config plan` needs a login). Adapters were exercised through
  their real libraries with faked transports; run `npm run db:check` and `npm run eval:grading` with your
  credentials before going live.
* **Docker build not executed** (Docker is not installed on the development machine). Its steps were rehearsed
  in a clean copy (`npm ci` → `npm run build` → `npm prune --omit=dev` → `node dist/src/main.js` loads every module
  and stops at the config check); the first real image build happens on Railway.
* OCR downloads language data from the tesseract.js CDN on first use (`uzb`, `uzb_cyrl`, `eng`, `rus`); verified here
  with `eng` only. Large scanned PDFs are bounded by `OCR_MAX_PAGES` and timeouts; extraction runs in the worker
  process (a pathological PDF can use CPU until the timeout).
* Extra (non-lesson) questions whose facts the reviewer cannot confirm with high confidence are **rejected**; no
  retrieval source is configured.
* Real AI providers: OpenAI (default, `gpt-6-luna`) and Anthropic, behind the `AiProvider` interface.
* Admin panel texts are Uzbek; student texts support uz / ru / en per group.
* Overnight game windows are rejected by design in this version.
* `npm audit` reports a moderate advisory in `sprintf-js` via `mammoth`'s command-line dependency (`argparse`);
  the bot only uses mammoth's library API (`extractRawText`).
