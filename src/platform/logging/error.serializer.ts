import { isAppError } from "../../shared/errors/app-error.js";

export interface SerializedError {
  readonly type: string;
  readonly message: string;
  readonly stack?: string | undefined;
  readonly code?: string | undefined;
  readonly severity?: string | undefined;
  readonly meta?: Readonly<Record<string, unknown>> | undefined;
  readonly cause?: SerializedError | string | undefined;
}

/** Guards against a self-referential `cause` chain turning logging into a hang. */
const MAX_CAUSE_DEPTH = 5;

/**
 * Credentials embedded in a connection URI, e.g. `postgres://bot:pw@host/db`.
 *
 * Key-path redaction cannot reach these: the secret is not at a named key, it
 * is spliced into the *text* of a driver's error message and stack. A dropped
 * database or Redis connection — the most ordinary event in a deploy — puts the
 * password in `message` and again in `stack`, and from there into whatever
 * aggregator collects stdout. Scrubbing the userinfo segment keeps the host and
 * scheme, which is the part an operator actually needs.
 */
const CREDENTIALS_IN_URI = /\/\/[^/\s:@]+:[^/\s@]+@/g;

function scrubCredentials(text: string): string {
  return text.replace(CREDENTIALS_IN_URI, "//[redacted]@");
}

/**
 * Normalises anything throwable into a stable log shape.
 *
 * Written by hand rather than using pino's `stdSerializers.err` for two
 * reasons: a lot of what gets thrown in JavaScript is not an Error, and
 * AppError carries `code`, `severity`, and `meta` that are the most useful
 * fields in the record and that a generic serialiser drops.
 *
 * `userMessage` is deliberately omitted — it is the user's copy of the failure,
 * not the operator's, and duplicating it into logs only adds noise.
 */
export function serializeError(value: unknown, depth = 0): SerializedError {
  if (value instanceof Error) {
    const serialized: SerializedError = {
      type: value.name,
      message: scrubCredentials(value.message),
      stack: value.stack === undefined ? undefined : scrubCredentials(value.stack),
      ...(isAppError(value)
        ? { code: value.code, severity: value.severity, meta: value.meta }
        : {}),
      ...(value.cause !== undefined && depth < MAX_CAUSE_DEPTH
        ? { cause: serializeError(value.cause, depth + 1) }
        : {}),
    };
    return serialized;
  }

  if (typeof value === "string") {
    return { type: "String", message: scrubCredentials(value) };
  }

  // Someone threw a number, an object literal, or undefined. Say so plainly
  // rather than rendering "[object Object]" and losing the trail.
  return { type: typeof value, message: scrubCredentials(safeStringify(value)) };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
