import { readFileSync } from "node:fs";
import type { AppConfig } from "../config.js";
import { parseContent, type ContentOf } from "../domain/content.js";
import type { GameType } from "../domain/gameTypes.js";
import { engineFor } from "../games/engines.js";
import { buildGradeRequest } from "./grader.js";
import type { AiProvider } from "./provider.js";

export interface EvalCase {
  id: string;
  q: string;
  answer: string;
  category: string;
  accept: string[];
}

export interface EvalResult {
  id: string;
  category: string;
  verdict: string;
  via: "deterministic" | "ai" | "ai_error";
  ok: boolean;
  falseCorrect: boolean;
  ms: number;
}

/**
 * Runs the grading evaluation set through the production path: deterministic rules first, then the AI
 * grader with the exact production request. Reports errors per category instead of trusting confidence.
 */
export async function runGradingEval(ai: AiProvider, cfg: Pick<AppConfig, "AI_GRADING_MODEL" | "AI_GRADING_EFFORT" | "AI_TIMEOUT_MS">, file: string, allowTranslations = false) {
  const data = JSON.parse(readFileSync(file, "utf8")) as { questions: Record<string, { gameType: GameType; content: unknown }>; cases: EvalCase[] };
  const results: EvalResult[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const c of data.cases) {
    const q = data.questions[c.q]!;
    const content = parseContent(q.gameType, q.content);
    const t0 = performance.now();
    const det = engineFor(q.gameType).grade(content, { text: c.answer }, { aiGradingEnabled: true });
    let verdict: string = det;
    let via: EvalResult["via"] = "deterministic";
    if (det === "needs_ai") {
      const isCode = q.gameType === "find_mistake";
      const fm = content as ContentOf<"find_mistake">;
      const gw = content as ContentOf<"guess_word">;
      try {
        const res = await ai.structured(
          buildGradeRequest(cfg, {
            requestKey: `eval-${c.id}`,
            gameType: q.gameType,
            question: isCode ? `${fm.prompt}\n${fm.code}` : gw.clues.join("\n"),
            rubric: isCode ? fm.rubric : "The guess must name the same word/term as the answer.",
            acceptedAnswers: isCode ? [fm.fixedCode, ...fm.acceptedFixes] : [gw.answer, ...gw.acceptedVariants],
            sourceExcerpt: "",
            studentAnswer: c.answer,
            language: "uz",
            allowTranslations,
          }),
        );
        verdict = res.data.verdict;
        via = "ai";
        inputTokens += res.inputTokens;
        outputTokens += res.outputTokens;
      } catch {
        verdict = "needs_review";
        via = "ai_error";
      }
    }
    const ok = c.accept.includes(verdict);
    results.push({ id: c.id, category: c.category, verdict, via, ok, falseCorrect: verdict === "correct" && !c.accept.includes("correct"), ms: performance.now() - t0 });
  }
  const byCategory: Record<string, { n: number; errors: number }> = {};
  for (const r of results) {
    const b = (byCategory[r.category] ??= { n: 0, errors: 0 });
    b.n++;
    if (!r.ok) b.errors++;
  }
  return {
    results,
    byCategory,
    total: results.length,
    errors: results.filter((r) => !r.ok).length,
    falseCorrect: results.filter((r) => r.falseCorrect).length,
    aiCalls: results.filter((r) => r.via !== "deterministic").length,
    inputTokens,
    outputTokens,
  };
}
