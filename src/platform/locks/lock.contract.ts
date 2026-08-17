/**
 * The distributed lock port.
 *
 * Exists so that "run this exactly once across every instance" is expressible
 * without the caller knowing whether there is one instance or six. In
 * development a process-local mutex satisfies it; in production a Redis lease
 * does.
 *
 * The `signal` is the part that matters. A lease can be lost — the holder
 * pauses, the TTL expires, another instance takes over — and work that keeps
 * running after losing its lease is work running twice. Handlers must check the
 * signal between steps, and must stop when it aborts.
 */
export interface Lock {
  /**
   * Runs `work` while holding `name`, renewing the lease until it returns.
   *
   * @returns the result of `work`, or `undefined` if the lock was already held
   *   by someone else. `undefined` is a normal outcome, not an error: it means
   *   another instance is doing the job.
   */
  runExclusive<T>(
    name: string,
    ttlMs: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined>;
}
