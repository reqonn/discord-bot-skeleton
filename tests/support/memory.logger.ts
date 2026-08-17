import type { ErrorLogFields, LogFields, Logger } from "#platform/logging/logger.contract.js";

export type LogLevelName = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface CapturedLog {
  readonly level: LogLevelName;
  readonly message: string;
  readonly fields: LogFields;
}

/**
 * An in-memory Logger for tests.
 *
 * A fake, not a mock: it behaves like a real logger, so a test asserts on what
 * was logged rather than on which method was called with which arguments. When
 * the Logger interface changes, this fails to compile — which is exactly the
 * feedback a mock would swallow.
 *
 * Child loggers share the parent's record list, so one assertion sees
 * everything the subject logged regardless of how it structured its loggers.
 */
export class MemoryLogger implements Logger {
  readonly records: CapturedLog[];
  private readonly bindings: LogFields;

  constructor(bindings: LogFields = {}, records: CapturedLog[] = []) {
    this.bindings = bindings;
    this.records = records;
  }

  trace(message: string, fields?: LogFields): void {
    this.capture("trace", message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.capture("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.capture("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.capture("warn", message, fields);
  }

  error(message: string, fields?: ErrorLogFields): void {
    this.capture("error", message, fields);
  }

  fatal(message: string, fields?: ErrorLogFields): void {
    this.capture("fatal", message, fields);
  }

  child(bindings: LogFields): Logger {
    return new MemoryLogger({ ...this.bindings, ...bindings }, this.records);
  }

  /** Every message, optionally narrowed to one level. */
  messages(level?: LogLevelName): string[] {
    return this.records
      .filter((record) => level === undefined || record.level === level)
      .map((record) => record.message);
  }

  /** The first record whose message contains `text`, for targeted assertions. */
  find(text: string): CapturedLog | undefined {
    return this.records.find((record) => record.message.includes(text));
  }

  /** True if anything was logged at `warn` or above. */
  hasProblems(): boolean {
    return this.records.some(
      (record) => record.level === "warn" || record.level === "error" || record.level === "fatal",
    );
  }

  clear(): void {
    this.records.length = 0;
  }

  private capture(level: LogLevelName, message: string, fields?: LogFields): void {
    this.records.push({ level, message, fields: { ...this.bindings, ...fields } });
  }
}
