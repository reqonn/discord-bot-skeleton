/**
 * How long this process has been up, and what it is holding.
 *
 * A port for two `process` calls, which looks like ceremony until you try to
 * test a handler that reports uptime: with this, a test states "the bot has
 * been up for three days" and asserts the formatting. Without it, the assertion
 * depends on how long the test runner has been running.
 *
 * It is also the layering rule doing its job — `api/` and `application/` do not
 * reach for Node built-ins, they declare what they need and are handed it.
 */
export interface RuntimeInfo {
  /** Milliseconds since the process started. */
  uptimeMs(): number;

  /**
   * Resident set size in bytes — the number a host's memory limit applies to.
   *
   * Deliberately not heap usage, which excludes buffers and native allocations
   * and so reads lower than the figure that actually gets a container killed.
   */
  memoryBytes(): number;
}
