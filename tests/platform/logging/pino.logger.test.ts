import { beforeEach, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "#platform/config/config.js";
import { createRequestContext, runWithRequestContext } from "#platform/context/request-context.js";
import type { Logger } from "#platform/logging/logger.contract.js";
import { createLogger } from "#platform/logging/pino.logger.js";

import { NotFoundError } from "#shared/errors/app-error.js";
import { asSnowflake } from "#shared/types/snowflake.types.js";

/** One emitted log record, parsed back from the pino output stream. */
type Record_ = Readonly<Record<string, unknown>>;

const CONFIG: Config = loadConfig({
  DISCORD_TOKEN: "token",
  DISCORD_CLIENT_ID: "1",
  DATABASE_URL: "postgres://localhost/bot",
  LOG_LEVEL: "trace",
});

describe("createLogger", () => {
  let records: Record_[];
  let log: Logger;

  beforeEach(() => {
    records = [];
    log = createLogger(CONFIG, {
      write(chunk: string) {
        records.push(JSON.parse(chunk) as Record_);
      },
    });
  });

  it("emits the message and its fields", () => {
    log.info("ticket opened", { ticketId: "abc", guildCount: 3 });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ msg: "ticket opened", ticketId: "abc", guildCount: 3 });
  });

  it("stamps the environment on every record", () => {
    log.info("hello");

    expect(records[0]).toMatchObject({ env: "development" });
  });

  it("supports every level in the contract", () => {
    log.trace("a");
    log.debug("b");
    log.info("c");
    log.warn("d");
    log.error("e");
    log.fatal("f");

    expect(records.map((r) => r["msg"])).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  describe("request context", () => {
    it("attaches correlation fields with no call-site involvement", () => {
      // The point of the ambient context: this call passes no ids, and the
      // record still carries all of them.
      const context = createRequestContext(
        {
          source: "command",
          operation: "ticket open",
          guildId: asSnowflake("111111111111111111"),
          userId: asSnowflake("222222222222222222"),
        },
        0,
      );

      runWithRequestContext(context, () => {
        log.info("handled");
      });

      expect(records[0]).toMatchObject({
        correlationId: context.correlationId,
        source: "command",
        operation: "ticket open",
        guildId: "111111111111111111",
        userId: "222222222222222222",
      });
    });

    it("omits correlation fields outside a request", () => {
      log.info("startup");

      expect(records[0]).not.toHaveProperty("correlationId");
      expect(records[0]).not.toHaveProperty("guildId");
    });
  });

  describe("redaction", () => {
    it("censors secret-bearing field names", () => {
      log.info("connecting", { token: "super-secret", connectionString: "postgres://u:p@h/d" });

      expect(records[0]).toMatchObject({
        token: "[redacted]",
        connectionString: "[redacted]",
      });
    });

    it("censors them when nested", () => {
      log.info("connecting", { discord: { token: "super-secret" } });

      expect(records[0]?.["discord"]).toMatchObject({ token: "[redacted]" });
    });
  });

  describe("error serialisation", () => {
    it("expands an AppError into its diagnostic fields", () => {
      log.error("failed", { error: new NotFoundError("No such ticket.", { detail: "id=7" }) });

      expect(records[0]?.["error"]).toMatchObject({
        type: "NotFoundError",
        message: "id=7",
        code: "NOT_FOUND",
        severity: "expected",
      });
    });

    it("keeps the user-facing message out of the record", () => {
      log.error("failed", { error: new NotFoundError("No such ticket.", { detail: "id=7" }) });

      expect(JSON.stringify(records[0])).not.toContain("No such ticket.");
    });

    it("survives a non-Error being thrown", () => {
      log.error("failed", { error: { weird: true } });

      expect(records[0]?.["error"]).toMatchObject({ type: "object", message: '{"weird":true}' });
    });

    it("preserves other fields alongside the error", () => {
      log.error("failed", { error: new Error("boom"), ticketId: "abc" });

      expect(records[0]).toMatchObject({ ticketId: "abc" });
    });

    it("serialises an error at every level, not only error and fatal", () => {
      // A native Error has non-enumerable `message` and `stack`, so handing one
      // straight to pino serialises to `{}`. Every level takes the same path so
      // that a warn about a dropped connection says what actually happened.
      for (const level of ["trace", "debug", "info", "warn"] as const) {
        records.length = 0;
        log[level]("dependency failed", { error: new Error("boom") });

        expect(records[0]?.["error"]).toMatchObject({ type: "Error", message: "boom" });
      }
    });
  });

  describe("credentials in an error message", () => {
    // Key-path redaction cannot reach these: the password is spliced into the
    // text of a driver's error, not sitting at a named key. A dropped database
    // connection is the ordinary case, and it puts the URI in message *and*
    // stack.
    const connectionFailure = (): Error =>
      new Error("connect ECONNREFUSED postgres://bot:hunter2@db.internal:5432/bot");

    it("scrubs the password from the message", () => {
      log.error("query failed", { error: connectionFailure() });

      expect(JSON.stringify(records[0])).not.toContain("hunter2");
    });

    it("scrubs it from the stack as well", () => {
      const error = connectionFailure();
      error.stack = `Error: connect ECONNREFUSED postgres://bot:hunter2@db.internal:5432/bot\n    at connect`;

      log.error("query failed", { error });

      const { stack } = records[0]?.["error"] as { stack: string };
      expect(stack).not.toContain("hunter2");
      expect(stack).toContain("postgres://[redacted]@db.internal");
    });

    it("scrubs it from a wrapped driver error's cause chain", () => {
      // How this actually reaches a log: the driver error is wrapped, and the
      // wrapper is what gets logged.
      const wrapped = new Error("Query failed", { cause: connectionFailure() });

      log.error("query failed", { error: wrapped });

      expect(JSON.stringify(records[0])).not.toContain("hunter2");
    });

    it("scrubs a Redis URL the same way", () => {
      log.warn("Redis error", { error: new Error("connect redis://default:s3cret@cache:6379") });

      expect(JSON.stringify(records[0])).not.toContain("s3cret");
    });

    it("keeps the host and scheme, which is the part worth logging", () => {
      log.error("query failed", { error: connectionFailure() });

      expect(records[0]?.["error"]).toMatchObject({
        message: "connect ECONNREFUSED postgres://[redacted]@db.internal:5432/bot",
      });
    });

    it("leaves an ordinary message untouched", () => {
      log.error("failed", { error: new Error("no such column: user_id") });

      expect(records[0]?.["error"]).toMatchObject({ message: "no such column: user_id" });
    });
  });

  it("stamps child bindings onto every record", () => {
    const child = log.child({ subsystem: "database" });
    child.info("query finished");

    expect(records[0]).toMatchObject({ subsystem: "database", msg: "query finished" });
  });
});
