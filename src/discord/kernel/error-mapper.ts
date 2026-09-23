import { DiscordAPIError } from "discord.js";

import {
  AppError,
  DiscordError,
  InternalError,
  isAppError,
  type AppErrorOptions,
} from "../../shared/errors/app-error.js";
import { say } from "../../shared/errors/phrasing.js";

/**
 * Discord's error codes, by name.
 *
 * The one place in this codebase that spells one. A number written at a call
 * site is unreadable six months later and impossible to grep for, and the same
 * code gets redeclared in two gateways that then disagree about it.
 */
export const DiscordCode = {
  UnknownChannel: 10_003,
  UnknownGuild: 10_004,
  UnknownMember: 10_007,
  UnknownMessage: 10_008,
  UnknownRole: 10_011,
  UnknownUser: 10_013,
  UnknownEmoji: 10_014,
  /** The three-second acknowledgement window closed. */
  UnknownInteraction: 10_062,
  InteractionAcknowledged: 40_060,
  MissingAccess: 50_001,
  /** Their DMs are closed to the bot, or they share no server with it. */
  CannotMessageUser: 50_007,
  MissingPermissions: 50_013,
  InvalidFormBody: 50_035,
} as const;

/**
 * Discord API error codes that mean "the thing you addressed is gone".
 *
 * These are routine — a user deletes the channel mid-command, an interaction
 * token expires while a slow handler runs — and treating them as incidents
 * buries real failures under noise.
 */
const GONE_CODES = new Set<number>([
  DiscordCode.UnknownChannel,
  DiscordCode.UnknownMessage,
  DiscordCode.UnknownInteraction,
  DiscordCode.InteractionAcknowledged,
  DiscordCode.UnknownRole,
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

/** How many AppError wrappers to unwrap before giving up looking for a code. */
const MAX_WRAPPER_DEPTH = 4;

interface DiscordApiShape {
  readonly code?: unknown;
  readonly status?: unknown;
}

/**
 * The Discord failure inside whatever was caught or handed back.
 *
 * **The outbound limiter never throws.** It answers a failure as a `Result`
 * whose error is `toAppError(cause)` — so by the time a caller asks about a
 * code, the `DiscordAPIError` is one layer down, and a gateway that re-raises
 * that as its own fault puts it two down. An `instanceof DiscordAPIError`
 * check against the wrapper is false for every code there is, which silently
 * turns "the message was deleted" into "an incident happened".
 *
 * So every question about a Discord code is asked through here, and answers
 * the same whether the failure was thrown or returned.
 */
function discordFailureIn(error: unknown): DiscordApiShape | null {
  let inner = error;
  for (let depth = 0; depth < MAX_WRAPPER_DEPTH && isAppError(inner); depth += 1) {
    inner = inner.cause;
  }

  return typeof inner === "object" && inner !== null ? inner : null;
}

function codeIn(error: unknown, codes: ReadonlySet<number>): boolean {
  const code = discordFailureIn(error)?.code;
  return typeof code === "number" && codes.has(code);
}

/** True when the failure means the interaction or its target no longer exists. */
export function isGone(error: unknown): boolean {
  return codeIn(error, GONE_CODES);
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

/**
 * The same failure, worded so it can be reported.
 *
 * A new error rather than a mutation: `AppError` is readonly by design, and
 * the one that was thrown may be shared. The original stays intact for the
 * logs as `cause`; this is only what the user reads.
 *
 * `detail` and `meta` are carried across so a development render still shows
 * the real cause under the sentence, and the code is kept so metrics still
 * see which class of thing failed.
 */
export function reportable(error: AppError, incident: string): AppError {
  return new ReportedError(say.unexpected(incident), {
    code: error.code,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    meta: { ...error.meta, incident },
    cause: error,
  });
}

/**
 * A fault as the user sees it: the incident sentence over the original.
 *
 * Private to this file. Nothing raises one; the pipeline builds it from a
 * failure that has already happened.
 */
class ReportedError extends AppError {
  constructor(userMessage: string, options: AppErrorOptions & { readonly code: string }) {
    super({ ...options, severity: "unexpected", userMessage });
  }
}
