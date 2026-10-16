import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";
import { AiPermanentError, type AiProvider, type StructuredRequest, type StructuredResult } from "./provider.js";

/**
 * OpenAI via the official `openai` SDK (Responses API). Verified against developers.openai.com (2026-10):
 * gpt-6-luna supports the Responses API, structured outputs, image input and reasoning effort
 * none|low|medium|high|xhigh|max; 1.05M context, 128K max output; $0.10 / $0.50 per 1M tokens.
 *
 * Structured output uses `text.format` = strict JSON schema built from our Zod schema (`zodTextFormat`);
 * the JSON is validated again by our own schema and the deterministic checks. Refusals and truncated
 * output are permanent errors (not retried); 429/5xx/network errors are retryable by the caller.
 */
export class OpenAIProvider implements AiProvider {
  readonly name = "openai";
  readonly isMock = false;
  private readonly client: OpenAI;

  constructor(apiKey: string, opts: { maxRetries: number; baseURL?: string; fetch?: typeof fetch }) {
    this.client = new OpenAI({ apiKey, maxRetries: opts.maxRetries, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const content = req.content.map((c) =>
      c.type === "text"
        ? ({ type: "input_text", text: c.text } as const)
        : ({ type: "input_image", image_url: `data:${c.mediaType};base64,${c.base64}`, detail: "auto" } as const),
    );
    try {
      const response = await this.client.responses.create(
        {
          model: req.model,
          instructions: req.system,
          input: [{ role: "user", content }],
          text: { format: zodTextFormat(req.schema as z.ZodType<T>, req.task) },
          reasoning: { effort: req.effort },
          max_output_tokens: req.maxTokens,
          // No conversation state is kept on OpenAI's side.
          store: false,
        },
        { timeout: req.timeoutMs },
      );
      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason ?? "unknown";
        throw new AiPermanentError(`output incomplete (${reason})`, reason === "max_output_tokens" ? "max_tokens" : "incomplete");
      }
      if (response.status === "failed") throw new Error(`response failed: ${response.error?.message ?? "unknown"}`);
      for (const item of response.output) {
        if (item.type === "message") {
          for (const part of item.content) {
            if (part.type === "refusal") throw new AiPermanentError(`model refused: ${part.refusal.slice(0, 200)}`, "refusal");
          }
        }
      }
      let json: unknown;
      try {
        json = JSON.parse(response.output_text);
      } catch {
        throw new AiPermanentError("structured output was not valid JSON", "invalid_output");
      }
      const checked = req.schema.safeParse(json);
      if (!checked.success) throw new AiPermanentError(`structured output failed validation: ${checked.error.issues[0]?.message ?? ""}`, "invalid_output");
      return {
        data: checked.data,
        model: response.model,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
    } catch (err) {
      if (err instanceof AiPermanentError) throw err;
      if (err instanceof OpenAI.BadRequestError || err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.NotFoundError || err instanceof OpenAI.PermissionDeniedError) {
        throw new AiPermanentError(`${err.status} ${err.message}`, "bad_request");
      }
      throw err; // RateLimitError, InternalServerError, APIConnectionError, timeouts: retryable
    }
  }
}
