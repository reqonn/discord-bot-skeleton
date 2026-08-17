import { DiscordAPIError } from "discord.js";

import {
  DiscordError,
  InternalError,
  isAppError,
  type AppError,
} from "../../shared/errors/app-error.js";

/**
 * Discord API error codes that mean "the thing you addressed is gone".
 *
 * These are routine — a user deletes the channel mid-command, an interaction
 * token expires while a slow handler runs — and treating them as incidents
 * buries real failures under noise.
 */
const GONE_CODES = new Set<number>([
  10_003, // Unknown Channel
  10_008, // Unknown Message
  10_062, // Unknown Interaction (the token expired)
  10_011, // Unknown Role
]);

/**
 * Normalises anything thrown into an AppError.
 *
 * The pipeline always has something to render, and the decision about what a
 * user is allowed to see is made once, here, rather than at each catch site.
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;

  if (error instanceof DiscordAPIError) {
    return new DiscordError(`Discord API error ${String(error.code)}: ${error.message}`, {
      cause: error,
      meta: { discordCode: error.code, status: error.status },
    });
  }

  return new InternalError(error instanceof Error ? error.message : String(error), {
    cause: error,
  });
}

/** True when the failure means the interaction or its target no longer exists. */
export function isGone(error: unknown): boolean {
  return error instanceof DiscordAPIError && GONE_CODES.has(Number(error.code));
}

/**
 * Whether a failure is worth an error-level log.
 *
 * Expected failures — a validation error, a missing permission — are the system
 * working. Logging them at error level trains people to ignore the error level,
 * which is how a real incident gets missed.
 */
export function isWorthReporting(error: AppError): boolean {
  return error.severity === "unexpected";
}
