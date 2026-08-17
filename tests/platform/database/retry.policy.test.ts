import { describe, expect, it } from "vitest";

import {
  backoffDelayMs,
  decideRetry,
  isConnectionFailure,
  isReadOnlyStatement,
  isTransientServerError,
  type RetryContext,
} from "#platform/database/retry.policy.js";

/** A driver error as `pg` surfaces it. */
function pgError(code: string): Error & { code: string } {
  return Object.assign(new Error(`database error ${code}`), { code });
}

function context(overrides: Partial<RetryContext> = {}): RetryContext {
  return {
    attempt: 1,
    elapsedMs: 0,
    inTransaction: false,
    sql: "SELECT 1",
    ...overrides,
  };
}

/** Removes jitter so delays are assertable. */
const noJitter = () => 1;

describe("classification", () => {
  it("recognises connection failures", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "08006", "08P01"]) {
      expect(isConnectionFailure(pgError(code))).toBe(true);
    }
  });

  it("recognises transient server errors", () => {
    for (const code of ["57P01", "57P03", "53300"]) {
      expect(isTransientServerError(pgError(code))).toBe(true);
    }
  });

  it("treats a statement timeout as neither", () => {
    // 57014 is query_canceled — the statement exceeded statement_timeout. It
    // will exceed it again, and retrying spends the interaction budget on a
    // guaranteed second failure.
    expect(isConnectionFailure(pgError("57014"))).toBe(false);
    expect(isTransientServerError(pgError("57014"))).toBe(false);
  });

  it("survives things that are not errors at all", () => {
    for (const value of [undefined, null, "boom", 42, {}]) {
      expect(isConnectionFailure(value)).toBe(false);
      expect(isTransientServerError(value)).toBe(false);
    }
  });
});

describe("isReadOnlyStatement", () => {
  it("accepts reads", () => {
    expect(isReadOnlyStatement("SELECT 1")).toBe(true);
    expect(isReadOnlyStatement("  select * from tickets")).toBe(true);
    expect(isReadOnlyStatement("EXPLAIN SELECT 1")).toBe(true);
  });

  it("looks past leading comments and whitespace", () => {
    expect(isReadOnlyStatement("-- fetch open tickets\nSELECT 1")).toBe(true);
    expect(isReadOnlyStatement("/* cached */ SELECT 1")).toBe(true);
    expect(isReadOnlyStatement("\n\n  SELECT 1")).toBe(true);
  });

  it("rejects writes", () => {
    expect(isReadOnlyStatement("INSERT INTO tickets VALUES (1)")).toBe(false);
    expect(isReadOnlyStatement("UPDATE tickets SET x = 1")).toBe(false);
    expect(isReadOnlyStatement("DELETE FROM tickets")).toBe(false);
  });

  it("rejects a CTE, because it may contain a write", () => {
    // `WITH x AS (INSERT … RETURNING *) SELECT * FROM x` reads like a query and
    // is not one. Being conservative costs an un-retried SELECT; being
    // permissive duplicates an INSERT.
    expect(isReadOnlyStatement("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(false);
  });
});

describe("decideRetry", () => {
  describe("connection failures", () => {
    it("retries, because nothing was executed", () => {
      const decision = decideRetry(pgError("ECONNREFUSED"), context(), undefined, noJitter);

      expect(decision).toMatchObject({ retry: true });
    });

    it("retries a write too — an unestablished connection carried nothing", () => {
      const decision = decideRetry(
        pgError("ECONNREFUSED"),
        context({ sql: "INSERT INTO tickets VALUES (1)" }),
        undefined,
        noJitter,
      );

      expect(decision).toMatchObject({ retry: true });
    });
  });

  describe("transient server errors", () => {
    it("retries a read", () => {
      expect(decideRetry(pgError("57P01"), context(), undefined, noJitter)).toMatchObject({
        retry: true,
      });
    });

    it("refuses a write, which may already have applied", () => {
      const decision = decideRetry(
        pgError("57P01"),
        context({ sql: "UPDATE tickets SET status = 'closed'" }),
        undefined,
        noJitter,
      );

      expect(decision).toEqual({ retry: false, reason: "statement may have applied" });
    });

    it("refuses inside a transaction, which is already aborted", () => {
      const decision = decideRetry(
        pgError("57P01"),
        context({ inTransaction: true }),
        undefined,
        noJitter,
      );

      expect(decision).toEqual({ retry: false, reason: "inside an aborted transaction" });
    });
  });

  it("refuses anything that will fail identically next time", () => {
    // Syntax error, constraint violation, permission denied.
    for (const code of ["42601", "23505", "42501"]) {
      expect(decideRetry(pgError(code), context(), undefined, noJitter)).toEqual({
        retry: false,
        reason: "not retryable",
      });
    }
  });

  describe("budget", () => {
    it("stops once attempts are exhausted", () => {
      const decision = decideRetry(
        pgError("ECONNREFUSED"),
        context({ attempt: 3 }),
        { maxAttempts: 3, deadlineMs: 2_000 },
        noJitter,
      );

      expect(decision).toEqual({ retry: false, reason: "attempts exhausted" });
    });

    it("stops at the deadline, so retrying never loses the interaction", () => {
      const decision = decideRetry(
        pgError("ECONNREFUSED"),
        context({ elapsedMs: 2_000 }),
        { maxAttempts: 5, deadlineMs: 2_000 },
        noJitter,
      );

      expect(decision).toEqual({ retry: false, reason: "retry deadline reached" });
    });

    it("never sleeps past the remaining budget", () => {
      const decision = decideRetry(
        pgError("ECONNREFUSED"),
        context({ attempt: 3, elapsedMs: 1_990 }),
        { maxAttempts: 5, deadlineMs: 2_000 },
        noJitter,
      );

      expect(decision).toEqual({ retry: true, delayMs: 10 });
    });
  });
});

describe("backoffDelayMs", () => {
  it("grows exponentially and then caps", () => {
    expect(backoffDelayMs(1, 10_000, noJitter)).toBe(50);
    expect(backoffDelayMs(2, 10_000, noJitter)).toBe(100);
    expect(backoffDelayMs(3, 10_000, noJitter)).toBe(200);
    expect(backoffDelayMs(10, 10_000, noJitter)).toBe(500);
  });

  it("applies full jitter", () => {
    // Without jitter every connection dropped by a failover retries in
    // lockstep and arrives as a herd exactly when the server can least take it.
    expect(backoffDelayMs(3, 10_000, () => 0)).toBe(0);
    expect(backoffDelayMs(3, 10_000, () => 0.5)).toBe(100);
    expect(backoffDelayMs(3, 10_000, () => 1)).toBe(200);
  });

  it("never returns a negative delay", () => {
    expect(backoffDelayMs(1, -100, noJitter)).toBe(0);
  });
});
