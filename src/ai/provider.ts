import type { z } from "zod";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type AiTask = "generate_questions" | "review_questions" | "grade_answer" | "review_picture";

export type AiContent = { type: "text"; text: string } | { type: "image"; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; base64: string };

export interface StructuredRequest<T> {
  task: AiTask;
  model: string;
  effort: Effort;
  system: string;
  content: AiContent[];
  schema: z.ZodType<T>;
  maxTokens: number;
  timeoutMs: number;
  /** Structured copy of the inputs, used only by the demo/test mock provider. */
  input: unknown;
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** Thrown for failures that should not be retried (refusal, invalid output, bad request). */
export class AiPermanentError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

/** Server-side AI adapter. Real: Anthropic Messages API. Mock: demo/test only. */
export interface AiProvider {
  readonly name: string;
  readonly isMock: boolean;
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export class DisabledAiProvider implements AiProvider {
  readonly name = "none";
  readonly isMock = false;
  async structured<T>(): Promise<StructuredResult<T>> {
    throw new AiPermanentError("AI is disabled (AI_PROVIDER=none)", "disabled");
  }
}
