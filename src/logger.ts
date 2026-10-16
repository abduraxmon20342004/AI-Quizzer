import { pino, type Logger } from "pino";

/**
 * Structured logger. Redaction removes tokens, keys and any raw student answer text that might be
 * attached to a log object by mistake. Code should log ids (submission id, student id), never content.
 */
export function createLogger(level: string, pretty: boolean): Logger {
  return pino({
    level,
    base: { service: "student-game-bot" },
    redact: {
      paths: [
        "token",
        "*.token",
        "apiKey",
        "*.apiKey",
        "ANTHROPIC_API_KEY",
        "BOT_TOKEN",
        "authorization",
        "*.authorization",
        "answerText",
        "*.answerText",
        "answer_text",
        "*.answer_text",
        "text",
        "*.text",
        "payload.text",
        "payload.caption",
      ],
      censor: "[redacted]",
    },
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } }
      : {}),
  });
}

export type { Logger };
