import { type ErrorCode, ErrorCodes } from "./error-code.js";

/**
 * How an error should be treated by logging and by the user-facing renderer.
 *
 * - `expected`   — a normal outcome of a valid request (wrong input, missing
 *                  permission, limit reached). Logged at `info`/`warn`. The
 *                  `userMessage` is the whole story; nothing is hidden.
 * - `unexpected` — a bug or an infrastructure failure. Logged at `error` with a
 *                  stack. The user sees a generic message; `detail` never
 *                  leaves the process in production.
 */
export type ErrorSeverity = "expected" | "unexpected";

export interface AppErrorOptions {
  /** Overrides the class default. Use for feature-specific codes. */
  readonly code?: ErrorCode;
  /** Internal diagnostic text. Never rendered to users in production. */
  readonly detail?: string;
  /** Structured context for logs. Must not contain secrets or user PII. */
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

interface AppErrorParams extends AppErrorOptions {
  readonly code: ErrorCode;
  readonly severity: ErrorSeverity;
  readonly userMessage: string;
}

/**
 * Base class for every error this codebase raises deliberately.
 *
 * The split between `userMessage` and `detail` is the point of this class: one
 * is safe to render into a Discord embed, the other is not, and the type makes
 * you decide which is which at the moment you create the error rather than at
 * the moment you display it.
 */
export abstract class AppError extends Error {
  readonly code: ErrorCode;
  readonly severity: ErrorSeverity;
  /** Safe to show to a Discord user, in any environment. */
  readonly userMessage: string;
  /** Internal only. Rendered in development, suppressed in production. */
  readonly detail: string | undefined;
  readonly meta: Readonly<Record<string, unknown>> | undefined;

  protected constructor(params: AppErrorParams) {
    // The Error message is the diagnostic one — logs want detail, users get
    // userMessage through a different path entirely.
    super(params.detail ?? params.userMessage, { cause: params.cause });
    this.name = new.target.name;
    this.code = params.code;
    this.severity = params.severity;
    this.userMessage = params.userMessage;
    this.detail = params.detail;
    this.meta = params.meta;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Input did not satisfy its schema. Raised before any use case runs. */
export class ValidationError extends AppError {
  constructor(userMessage: string, options: AppErrorOptions = {}) {
    super({
      ...options,
      code: options.code ?? ErrorCodes.VALIDATION_FAILED,
      severity: "expected",
      userMessage,
    });
  }
}

/** The actor may not do this. Deliberately does not distinguish "not allowed"
 *  from "does not exist" in its user message, to avoid leaking existence. */
export class AuthorizationError extends AppError {
  constructor(
    userMessage = "You do not have permission to do that.",
    options: AppErrorOptions = {},
  ) {
    super({
      ...options,
      code: options.code ?? ErrorCodes.UNAUTHORIZED,
      severity: "expected",
      userMessage,
    });
  }
}

export class NotFoundError extends AppError {
  constructor(userMessage: string, options: AppErrorOptions = {}) {
    super({
      ...options,
      code: options.code ?? ErrorCodes.NOT_FOUND,
      severity: "expected",
      userMessage,
    });
  }
}

/** The request conflicts with current state — a double click, a closed ticket. */
export class ConflictError extends AppError {
  constructor(userMessage: string, options: AppErrorOptions = {}) {
    super({
      ...options,
      code: options.code ?? ErrorCodes.CONFLICT,
      severity: "expected",
      userMessage,
    });
  }
}

export class RateLimitError extends AppError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, userMessage: string, options: AppErrorOptions = {}) {
    super({
      ...options,
      code: options.code ?? ErrorCodes.RATE_LIMITED,
      severity: "expected",
      userMessage,
    });
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Base class for errors expressing a broken business rule.
 *
 * Abstract because domain errors must be specific: a feature declares
 * `TicketLimitExceededError extends DomainError` with its own code, so the
 * failure is nameable in logs and testable by type rather than by string match.
 */
export abstract class DomainError extends AppError {
  protected constructor(params: Omit<AppErrorParams, "severity">) {
    super({ ...params, severity: "expected" });
  }
}

/** A dependency failed. Always unexpected — detail stays internal. */
export class InfrastructureError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super({
      ...options,
      code: options.code ?? ErrorCodes.INFRASTRUCTURE_FAILURE,
      severity: "unexpected",
      userMessage: "Something went wrong on our side. Please try again shortly.",
      detail,
    });
  }
}

/** Startup configuration was missing or invalid. Fatal by construction. */
export class ConfigurationError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super({
      ...options,
      code: options.code ?? ErrorCodes.CONFIGURATION_INVALID,
      severity: "unexpected",
      userMessage: "The bot is misconfigured. Please contact an administrator.",
      detail,
    });
  }
}

/** The Discord API rejected, dropped, or timed out a request. */
export class DiscordError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super({
      ...options,
      code: options.code ?? ErrorCodes.DISCORD_API_FAILURE,
      severity: "unexpected",
      userMessage: "Discord did not accept that action. Please try again shortly.",
      detail,
    });
  }
}

/**
 * Wraps an unexpected throw so the pipeline always has an AppError to render.
 * Constructed only by the error mapper — never raise this deliberately.
 */
export class InternalError extends AppError {
  constructor(detail: string, options: AppErrorOptions = {}) {
    super({
      ...options,
      code: options.code ?? ErrorCodes.INTERNAL,
      severity: "unexpected",
      userMessage: "Something went wrong. Please try again.",
      detail,
    });
  }
}
