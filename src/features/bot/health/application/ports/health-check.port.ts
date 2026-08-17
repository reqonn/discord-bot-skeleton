export interface CheckOutcome {
  readonly name: string;
  readonly healthy: boolean;
  readonly latencyMs: number;
  /** Short operator-facing note when unhealthy. Never contains credentials. */
  readonly detail?: string;
}

/**
 * One dependency the bot can report on.
 *
 * A port rather than the use case reaching for the database and cache directly:
 * the use case's job is "check everything and summarise", which is testable
 * with two fakes and no infrastructure at all. What "everything" happens to be
 * is a composition decision.
 */
export interface HealthCheck {
  readonly name: string;
  check(): Promise<CheckOutcome>;
}
