/**
 * Railway project definition (Infrastructure as Code; replaces the deprecated railway.json / railway.toml).
 *
 *   railway login
 *   railway link                 # or let `railway config apply` create the project
 *   railway config plan          # read-only preview
 *   railway config apply
 *
 * Deploy from GitHub: set GITHUB_REPO=owner/repo when running plan/apply (auto-deploys on push to main).
 * Without GITHUB_REPO the service has no source: deploy this folder with `railway up --service bot`.
 *
 * Secrets are declared with preserve(): set their values in the Railway dashboard (service -> Variables);
 * applying this file never overwrites or reveals them.
 */
import { defineRailway, github, postgres, preserve, service } from "railway/iac";

const REGION = "europe-west4"; // closest Railway region to Uzbekistan among the documented ones; change if needed
const repo = process.env.GITHUB_REPO;

export default defineRailway((_ctx, project) => {
  const db = postgres("postgres", { region: REGION });

  const bot = service("bot", {
    ...(repo ? { source: github(repo, { branch: "main" }) } : {}),
    build: { builder: "DOCKERFILE", dockerfilePath: "Dockerfile" },
    // /healthz checks the database and the scheduler heartbeat.
    healthcheck: "/healthz",
    healthcheckTimeout: 120,
    // One instance: the bot (webhook) and the worker run in one process. During a deploy the old and new
    // instances overlap briefly; publishing/sending is safe under that (row locks + compare-and-set).
    replicas: { [REGION]: 1 },
    deploy: {
      restartPolicyType: "ON_FAILURE",
      restartPolicyMaxRetries: 10,
      overlapSeconds: 15,
      drainingSeconds: 25,
    },
    env: {
      // Private network connection to the Railway Postgres (no TLS settings needed inside Railway).
      DATABASE_URL: db.env.DATABASE_URL,
      APP_MODE: "production",
      PROCESS_ROLE: "all",
      // Webhook mode; WEBHOOK_URL defaults to https://$RAILWAY_PUBLIC_DOMAIN (generate a domain for the service).
      TELEGRAM_MODE: "webhook",
      AI_PROVIDER: "openai",
      DEFAULT_TIMEZONE: "Asia/Tashkent",
      DEFAULT_LANGUAGE: "uz",
      LOG_LEVEL: "info",
      BOT_TOKEN: preserve(),
      BOT_ADMIN_IDS: preserve(),
      OPENAI_API_KEY: preserve(),
      WEBHOOK_SECRET: preserve(),
      CALLBACK_SECRET: preserve(),
    },
  });

  return project("student-game-bot", { resources: [bot, db] });
});
