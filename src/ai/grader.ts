import type { AppConfig } from "../config.js";
import { gradePrompt, type GradeInput } from "./prompts.js";
import type { StructuredRequest } from "./provider.js";
import { GradeSchema, type GradeOutput } from "./schemas.js";

/** The exact AI grading request used in production (also used by the grading evaluation). */
export function buildGradeRequest(cfg: Pick<AppConfig, "AI_GRADING_MODEL" | "AI_GRADING_EFFORT" | "AI_TIMEOUT_MS">, input: GradeInput): StructuredRequest<GradeOutput> {
  const prompt = gradePrompt(input);
  return {
    task: "grade_answer",
    model: cfg.AI_GRADING_MODEL,
    effort: cfg.AI_GRADING_EFFORT,
    system: prompt.system,
    content: [{ type: "text", text: prompt.text }],
    schema: GradeSchema,
    maxTokens: 2000,
    timeoutMs: Math.min(cfg.AI_TIMEOUT_MS, 60_000),
    input,
  };
}
