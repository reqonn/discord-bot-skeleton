/**
 * The words the bot uses when something goes wrong.
 *
 * Every user-facing failure message is built from here, so that two features
 * written a year apart reject a too-long value with the same sentence. Without
 * a shared vocabulary they end up *nearly* the same — "must be 8 characters or
 * fewer" beside "cannot exceed 8 chars" — which reads as two different bots.
 *
 * ## The voice
 *
 * - **Short.** One sentence. A user is mid-task, not reading documentation.
 * - **Bold the operative word**, so the reason survives a glance.
 * - **`Backticks` around anything literal** — a value they typed, a permission,
 *   a command to run next.
 * - **Say what to do next** when there is something to do. "Expired" is a fact;
 *   "expired, run `/welcome` again" is an answer.
 * - **Never blame.** "That prefix cannot contain spaces", not "you entered an
 *   invalid prefix".
 *
 * ## How to use it
 *
 * Domain errors compose their `userMessage` from these, rather than writing
 * prose inline:
 *
 * ```ts
 * export class InvalidPrefixError extends DomainError {
 *   constructor(reason: string) {
 *     super({ code: "PREFIX_INVALID", userMessage: reason });
 *   }
 * }
 *
 * err(new InvalidPrefixError(say.tooLong("A prefix", MAX_PREFIX_LENGTH)));
 * ```
 *
 * If a phrase is needed twice, add it here. If it is genuinely unique to one
 * feature, write it in that feature's `.errors.ts` — the point is one home per
 * phrase, not that every phrase lives in this file.
 */
export const say = {
  // ── Input ──────────────────────────────────────────────────────────────────

  empty: (label: string): string => `${label} cannot be **empty**.`,

  tooLong: (label: string, max: number): string =>
    `${label} must be **${String(max)} characters** or fewer.`,

  tooShort: (label: string, min: number): string =>
    `${label} must be at least **${String(min)} characters**.`,

  cannotContain: (label: string, what: string): string => `${label} cannot contain **${what}**.`,

  cannotStartWith: (label: string, prefix: string, why: string): string =>
    `${label} cannot start with \`${prefix}\` — ${why}.`,

  notAllowedValue: (label: string, value: string, why: string): string =>
    `${label} \`${value}\` will not work — ${why}.`,

  required: (label: string): string => `**${label}** is required.`,

  outOfRange: (label: string, min: number, max: number): string =>
    `${label} must be between **${String(min)}** and **${String(max)}**.`,

  // ── Lookups ────────────────────────────────────────────────────────────────

  notFound: (type: string, name?: string): string =>
    name === undefined
      ? `That **${type}** does not exist.`
      : `**${type}** \`${name}\` does not exist.`,

  alreadyExists: (type: string, name: string): string => `**${type}** \`${name}\` already exists.`,

  noneConfigured: (type: string): string => `No **${type}** configured.`,

  limitReached: (max: number, type: string): string =>
    `You have reached the limit of **${String(max)} ${type}**.`,

  // ── State ──────────────────────────────────────────────────────────────────

  /** Always name the way back — an expiry with no next step is a dead end. */
  expired: (what: string, restartWith: string): string =>
    `This ${what} has expired. Run \`${restartWith}\` to start a fresh one.`,

  /** For a multi-step flow that is not finished. `missing` is an instruction. */
  notReadyYet: (missing: string): string => `Nothing saved — **${missing}** first.`,

  alreadyDone: (what: string): string => `That ${what} already happened.`,

  // ── Access ─────────────────────────────────────────────────────────────────

  needsPermission: (permission: string, purpose: string): string =>
    `You need \`${permission}\` to ${purpose}.`,

  belongsToSomeoneElse: (what: string): string => `That ${what} belongs to someone else.`,
} as const;
