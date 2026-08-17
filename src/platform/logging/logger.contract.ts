/**
 * The logging port.
 *
 * Use cases and adapters depend on this interface, never on pino. That keeps
 * the application layer free of a library choice, and — more usefully — means a
 * test can assert on captured log records instead of scraping stdout.
 *
 * Message-first, unlike pino's object-first signature: `log.info("ticket
 * opened", { ticketId })` reads as a sentence at the call site, and the fields
 * stay optional.
 */
export interface Logger {
  trace(message: string, fields?: ErrorLogFields): void;
  debug(message: string, fields?: ErrorLogFields): void;
  info(message: string, fields?: ErrorLogFields): void;
  warn(message: string, fields?: ErrorLogFields): void;
  error(message: string, fields?: ErrorLogFields): void;
  fatal(message: string, fields?: ErrorLogFields): void;

  /**
   * A logger that stamps `bindings` onto every record.
   * Use for long-lived subsystems (`log.child({ subsystem: "database" })`).
   * Per-request fields need no child — they arrive from the request context.
   */
  child(bindings: LogFields): Logger;
}

/**
 * Structured fields attached to one record.
 *
 * Must not contain secrets or user content. Tokens, connection strings, and
 * authorization headers are redacted by the implementation as a backstop, but
 * the backstop is not the policy — see docs/architecture.md § Security.
 */
export type LogFields = Readonly<Record<string, unknown>>;

export type ErrorLogFields = LogFields & {
  /** Serialised with its message, stack, and cause chain. */
  readonly error?: unknown;
};
