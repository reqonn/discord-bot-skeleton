export interface CooldownVerdict {
  readonly allowed: boolean;
  /** Milliseconds until the next attempt would be allowed. Zero when allowed. */
  readonly retryAfterMs: number;
}

/**
 * Inbound rate limiting.
 *
 * Deliberately separate from the outbound Discord rate limiter. They solve
 * opposite problems — this one stops a user hammering a command, that one stops
 * us hammering Discord — and conflating them produces a limiter that is wrong
 * in both directions.
 *
 * Enforced by the interaction pipeline from each command's declared `cooldown`,
 * so no handler implements its own.
 */
export interface CooldownStore {
  /**
   * Records an attempt and reports whether it is allowed.
   *
   * Counting the attempt even when it is rejected is intentional: it means a
   * user hammering a command keeps their own cooldown alive rather than
   * resetting it by giving up for a moment.
   */
  hit(key: string, limit: number, windowMs: number): Promise<CooldownVerdict>;
}
