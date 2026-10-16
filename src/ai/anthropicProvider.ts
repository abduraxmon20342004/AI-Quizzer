import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { AiPermanentError, type AiProvider, type StructuredRequest, type StructuredResult } from "./provider.js";

/**
 * Claude via the official Anthropic SDK. Structured outputs (`output_config.format` built from a Zod schema,
 * parsed by `messages.parse`) guarantee schema-shaped JSON; the result is validated again by our own Zod
 * schema and deterministic checks. Model ids come from configuration (verified against the Claude model list
 * at implementation time: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5).
 *
 * The SDK retries 408/409/429/5xx and connection errors (`maxRetries`) with backoff; our job layer bounds
 * total attempts. Refusals (stop_reason "refusal") are permanent for that input. With AI_REFUSAL_FALLBACK=default
 * the server-side fallback chain is enabled (beta "server-side-fallback-2026-07-01").
 */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  readonly isMock = false;
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly opts: { refusalFallback: boolean; maxRetries: number; fetch?: typeof fetch }) {
    this.client = new Anthropic({ apiKey, maxRetries: opts.maxRetries, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const content = req.content.map((c) =>
      c.type === "text"
        ? ({ type: "text", text: c.text } as const)
        : ({ type: "image", source: { type: "base64", media_type: c.mediaType, data: c.base64 } } as const),
    );
    try {
      // create() (not parse()): the stop reason is checked before any JSON parsing, so a refusal or a
      // truncated answer is reported as such instead of as a parse failure.
      const response = await this.client.beta.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens,
          system: req.system,
          messages: [{ role: "user", content }],
          output_config: { effort: req.effort, format: betaZodOutputFormat(req.schema as z.ZodType<T>) },
          ...(this.opts.refusalFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { timeout: req.timeoutMs },
      );
      if (response.stop_reason === "refusal") {
        throw new AiPermanentError(`model declined (${response.stop_details?.category ?? "unspecified"})`, "refusal");
      }
      if (response.stop_reason === "max_tokens") throw new AiPermanentError("output truncated (max_tokens)", "max_tokens");
      const text = response.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new AiPermanentError("structured output was not valid JSON", "invalid_output");
      }
      const checked = req.schema.safeParse(json);
      if (!checked.success) throw new AiPermanentError(`structured output failed validation: ${checked.error.issues[0]?.message ?? ""}`, "invalid_output");
      const parsed = checked.data;
      return {
        data: parsed,
        model: response.model,
        inputTokens: response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0),
        outputTokens: response.usage.output_tokens,
      };
    } catch (err) {
      if (err instanceof AiPermanentError) throw err;
      if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new AiPermanentError(`${err.status} ${err.message}`, "bad_request");
      }
      throw err; // RateLimitError, InternalServerError, APIConnectionError, timeouts: retryable by the caller
    }
  }
}
