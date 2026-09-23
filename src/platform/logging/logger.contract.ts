import { isAppError } from "../../shared/errors/app-error.js";

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

/**
 * Lets work run without waiting for it, and says so when it fails.
 *
 * `void work` looks like it lets go of a promise. What it lets go of is the
 * *failure*: a rejection nobody handles reaches `unhandledRejection`, and
 * src/main.ts treats that as fatal — so one background notification Discord
 * refused, or one job tick whose lease Redis could not grant, takes the whole
 * process down for every guild it serves.
 *
 * Every piece of work nobody waits on goes through here, rather than each call
 * site inventing its own `.catch`. `what` names the work for whoever reads the
 * log: "Could not send the welcome message" answers the question a bare stack
 * trace does not.
 *
 * An expected failure is logged at warn and anything else at error — the same
 * split the pipeline makes for work somebody did wait on, so the error level
 * keeps meaning the same thing everywhere.
 */
export function detach(
  work: Promise<unknown>,
  logger: Logger,
  what: string,
  fields?: LogFields,
): void {
  void work.catch((error: unknown) => {
    const expected = isAppError(error) && error.severity === "expected";
    logger[expected ? "warn" : "error"](what, { ...fields, error });
  });
}
