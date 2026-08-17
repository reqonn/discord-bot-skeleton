/**
 * How urgent an outbound Discord call is.
 *
 * Priority exists so that background work cannot starve work a user is waiting
 * on. Under pressure the queue drains highest-first, and overflow drops from
 * the bottom — so a raid that floods the bot with cosmetic reactions delays
 * reactions, not the moderation action being taken in response to it.
 *
 * Lower number wins.
 */
export const ActionPriority = {
  /**
   * Never queued and never dropped. Only for calls where delay is equivalent to
   * failure: a moderation action, creating the channel a user is waiting for.
   *
   * Marking everything critical defeats the mechanism entirely — if nothing can
   * be delayed, nothing can be protected.
   */
  Critical: 0,
  /** Delayed only under real pressure. Permission edits, channel mutations. */
  High: 1,
  /** The default. Logs, notifications, welcome messages. */
  Normal: 2,
  /** First to be delayed and first to be dropped. Reactions, cosmetic cleanup. */
  Low: 3,
} as const;

export type ActionPriority = (typeof ActionPriority)[keyof typeof ActionPriority];

export type ActionOutcome =
  /** Ran immediately. */
  | "executed"
  /** Waited in the queue, then ran. */
  | "queued"
  /** The queue was full at this priority. */
  | "dropped"
  /** Waited past its deadline without running. */
  | "timed-out"
  /** Ran and threw. */
  | "failed"
  /** Refused without running: the circuit for this guild and feature is open. */
  | "short-circuited";

export interface LimiterSettings {
  /** Rolling window over which per-guild actions are counted. */
  readonly budgetWindowMs: number;
  /** Actions allowed per guild within that window before queueing begins. */
  readonly budgetMaxActions: number;
  /**
   * Rolling window for the process-wide ceiling.
   *
   * Per-guild budgets stop one server starving the others, but they say nothing
   * about the total. A bot in a thousand guilds can respect every per-guild
   * budget and still sail past Discord's global limit — at which point 429s
   * apply everywhere, which is the failure this whole component exists to
   * prevent.
   */
  readonly globalWindowMs: number;
  /** Actions allowed process-wide within that window. */
  readonly globalMaxActions: number;
  /** Concurrent in-flight calls per guild. */
  readonly concurrencyPerGuild: number;
  /** Pending actions held per guild before overflow drops begin. */
  readonly queueMaxPerGuild: number;
  /** How long a queued action waits before giving up. */
  readonly queueTimeoutMs: number;
  /** Failures within the circuit window before it opens. */
  readonly circuitFailureThreshold: number;
  readonly circuitWindowMs: number;
  /** How long an open circuit waits before allowing a probe. */
  readonly circuitCooldownMs: number;
  /** Safety-net drain tick, for queues held back by budget rather than concurrency. */
  readonly drainIntervalMs: number;
  /** How often idle guild budgets and circuits are forgotten. */
  readonly sweepIntervalMs: number;
}

/**
 * Defaults sized for Discord's per-route limits with headroom.
 *
 * The budget is deliberately below what Discord would actually allow: the point
 * is to shed load before Discord starts returning 429s, because once it does,
 * the penalty applies to every route the bot uses rather than the one that
 * caused it.
 */
export const DEFAULT_LIMITER_SETTINGS: LimiterSettings = {
  budgetWindowMs: 10_000,
  budgetMaxActions: 30,
  // Discord's global allowance is around 50 requests per second. Sitting under
  // it deliberately means the bot sheds load before Discord starts refusing —
  // once it does, the penalty applies to every route, not the greedy one.
  globalWindowMs: 1_000,
  globalMaxActions: 45,
  concurrencyPerGuild: 6,
  queueMaxPerGuild: 20,
  // Under the 15-minute interaction token lifetime by a wide margin: an action
  // that has waited ten seconds is one whose context is gone.
  queueTimeoutMs: 10_000,
  circuitFailureThreshold: 5,
  circuitWindowMs: 60_000,
  circuitCooldownMs: 120_000,
  drainIntervalMs: 200,
  sweepIntervalMs: 60_000,
};
