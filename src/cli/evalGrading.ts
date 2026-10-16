/**
 * AI grading evaluation. Uses the configured provider and grading model (real API calls cost money):
 *
 *   OPENAI_API_KEY=... npm run eval:grading                     # gpt-6-luna (default)
 *   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run eval:grading
 *   AI_PROVIDER=mock npm run eval:grading            # offline harness check only
 *
 * Run it before switching AI_GRADING_MODEL to a cheaper tier: only switch if errors and false-correct
 * verdicts do not increase.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { AiPricing } from "../ai/budget.js";
import { runGradingEval } from "../ai/evaluation.js";
import { createAi } from "../app/build.js";
import { loadConfig } from "../config.js";

const env = { ...process.env };
env.DATABASE_URL ||= "postgres://unused";
env.CALLBACK_SECRET ||= "eval-only-secret-0000";
if (env.AI_PROVIDER === "mock") env.APP_MODE = "test";
const cfg = loadConfig(env);
const ai = createAi(cfg);
if (ai.name === "none") {
  console.error("No AI provider configured (set OPENAI_API_KEY - or AI_PROVIDER=anthropic + ANTHROPIC_API_KEY - or AI_PROVIDER=mock for an offline harness check).");
  process.exit(2);
}
const file = new URL("../../data/grading-eval.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
console.log(`Grading eval: provider=${ai.name} model=${cfg.AI_GRADING_MODEL} effort=${cfg.AI_GRADING_EFFORT}`);
const r = await runGradingEval(ai, cfg, file);
for (const x of r.results) console.log(`${x.ok ? "ok " : "ERR"} ${x.id.padEnd(5)} ${x.category.padEnd(17)} ${x.verdict.padEnd(13)} via ${x.via}${x.falseCorrect ? "  <-- FALSE CORRECT" : ""}`);
console.log("\nby category:", Object.entries(r.byCategory).map(([k, v]) => `${k} ${v.n - v.errors}/${v.n}`).join(", "));
const cost = ai.isMock ? 0 : new AiPricing(cfg.AI_PRICING_JSON).cost(cfg.AI_GRADING_MODEL, r.inputTokens, r.outputTokens);
console.log(`errors ${r.errors}/${r.total}, false-correct ${r.falseCorrect}, AI calls ${r.aiCalls}, est. cost $${cost.toFixed(4)}${ai.isMock ? " (MOCK provider: measures the harness, not model quality)" : ""}`);
mkdirSync("reports", { recursive: true });
const out = `reports/grading-eval-${cfg.AI_GRADING_MODEL}-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(out, JSON.stringify({ model: cfg.AI_GRADING_MODEL, provider: ai.name, ...r }, null, 2));
console.log(`saved ${out}`);
process.exit(r.falseCorrect > 0 ? 1 : 0);
