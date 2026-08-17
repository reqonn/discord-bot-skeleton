/**
 * Stable, machine-readable error identifiers.
 *
 * Codes are part of the bot's observable surface: they appear in logs, metrics
 * labels, and support conversations. Treat them like a public API — add freely,
 * rename never.
 *
 * Convention: SCREAMING_SNAKE_CASE, feature-namespaced.
 *   Platform-wide  →  VALIDATION_FAILED, NOT_FOUND
 *   Feature-owned  →  TICKETS_LIMIT_EXCEEDED, TICKETS_ALREADY_CLOSED
 *
 * Features declare their own codes next to the errors that carry them
 * (`<feature>/domain/<name>.errors.ts`) rather than extending this file, so a
 * feature stays deletable in one directory.
 */
export type ErrorCode = string;

export const ErrorCodes = {
  /** Input failed schema validation before any use case ran. */
  VALIDATION_FAILED: "VALIDATION_FAILED",
  /** The actor is not permitted to perform this action. */
  UNAUTHORIZED: "UNAUTHORIZED",
  /** The addressed resource does not exist. */
  NOT_FOUND: "NOT_FOUND",
  /** The action conflicts with current state (double-submit, already closed). */
  CONFLICT: "CONFLICT",
  /** The actor exceeded a cooldown or abuse limit. */
  RATE_LIMITED: "RATE_LIMITED",
  /** A dependency (database, cache, HTTP peer) failed. */
  INFRASTRUCTURE_FAILURE: "INFRASTRUCTURE_FAILURE",
  /** Configuration was missing or invalid at startup. */
  CONFIGURATION_INVALID: "CONFIGURATION_INVALID",
  /** The Discord API rejected or dropped a request. */
  DISCORD_API_FAILURE: "DISCORD_API_FAILURE",
  /** Catch-all for an unexpected throw. Never carries detail to the user. */
  INTERNAL: "INTERNAL",
} as const satisfies Record<string, ErrorCode>;
