/**
 * A scheduled background job.
 *
 * Handlers contain no logic: they call a use case, exactly as a command
 * adapter does. A job is a trigger, not a place for behaviour — otherwise the
 * same rule ends up implemented twice, once for users and once for the
 * scheduler, and the two drift.
 */
export interface Job {
  /** `<feature>.<verb>-<noun>`, e.g. "tickets.expire-stale". */
  readonly id: string;

  /** How often to run. Interval scheduling only — see JobScheduler. */
  readonly everyMs: number;

  /** Delay before the first run. Lets a boot finish before work starts. */
  readonly delayMs?: number;

  /**
   * Whether this must run on only one instance at a time.
   *
   * True for anything with side effects — deleting channels, sending
   * reminders, charging anything. False only for genuinely idempotent
   * per-instance work such as refreshing a local cache.
   */
  readonly singleton: boolean;

  /**
   * Runs the job.
   *
   * `signal` aborts if a singleton job loses its lease mid-run. Check it
   * between steps of anything long: work that continues past that point is
   * work running on two instances at once.
   */
  run(signal: AbortSignal): Promise<void>;
}
