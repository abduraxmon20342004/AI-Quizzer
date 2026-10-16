import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runGradingEval } from "../../src/ai/evaluation.js";
import { MockAiProvider } from "../../src/ai/mockProvider.js";

/**
 * Offline check of the evaluation harness and the deterministic layer. The real model is evaluated with
 * `npm run eval:grading` (needs an API key) - the mock here proves the harness, not model quality.
 */
describe("grading evaluation set", () => {
  it("covers every required category and grades deterministic cases without AI", async () => {
    const file = fileURLToPath(new URL("../../data/grading-eval.json", import.meta.url));
    const ai = new MockAiProvider();
    const r = await runGradingEval(ai, { AI_GRADING_MODEL: "mock", AI_GRADING_EFFORT: "medium", AI_TIMEOUT_MS: 10_000 }, file);
    expect(Object.keys(r.byCategory).sort()).toEqual(["ambiguous", "correct", "equivalent_code", "multilingual", "near_miss", "prompt_injection", "wrong"]);
    // Exact answers, apostrophe variants and unchanged buggy code never need the AI.
    const det = r.results.filter((x) => x.via === "deterministic").map((x) => x.id);
    expect(det).toEqual(expect.arrayContaining(["gw1", "gw2", "gw10", "gw11", "gw14", "fm1", "fm5", "fm8"]));
    // Prompt-injection answers are never graded correct.
    expect(r.results.filter((x) => x.category === "prompt_injection").every((x) => x.verdict === "incorrect")).toBe(true);
    expect(r.falseCorrect).toBe(0);
  });

  it("reports AI failures as needs_review, never as a grade", async () => {
    const file = fileURLToPath(new URL("../../data/grading-eval.json", import.meta.url));
    const ai = new MockAiProvider();
    ai.failNext("grade_answer", "timeout", 100);
    const r = await runGradingEval(ai, { AI_GRADING_MODEL: "mock", AI_GRADING_EFFORT: "medium", AI_TIMEOUT_MS: 10_000 }, file);
    expect(r.results.filter((x) => x.via === "ai_error").every((x) => x.verdict === "needs_review")).toBe(true);
  });
});
