/**
 * PostgreSQL error codes worth retrying, and the rules for when.
 *
 * The distinction that matters is not "did it fail?" but "did it run?". A
 * connection that was never established ran nothing, so retrying is free. A
 * statement that reached the server and failed may have applied — retrying a
 * mutation in that state is how you get two of something.
 *
 * Everything here is a pure function so the rules can be tested exhaustively
 * without a database, which is the only realistic way to cover them: reproducing
 * a mid-query failover in a test suite is not practical.
 */

/**
 * The connection never carried the statement. Safe to retry regardless of what
 * the statement was going to do.
 */
const CONNECTION_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  // PostgreSQL class 08 — connection exception.
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08007",
  "08P01",
]);

/**
 * The server was reached but could not serve the request. Whether the statement
 * applied is unknowable from here, so these are retried only for reads.
 */
const TRANSIENT_SERVER_CODES = new Set([
  "57P01", // admin_shutdown — the backend was terminated, typically a failover
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now — server is starting up
  "53300", // too_many_connections
  "53400", // configuration_limit_exceeded
]);

/**
 * Deliberately absent: 57014 (query_canceled, i.e. statement_timeout).
 *
 * A query that exceeded its timeout will exceed it again, and retrying spends
 * the remaining interaction budget guaranteeing a second failure. Slow queries
 * need an index, not another attempt.
 */

export interface RetryContext {
  /** 1-based; the first attempt is 1. */
  readonly attempt: number;
  readonly elapsedMs: number;
  /** Inside an open transaction, where the session is already aborted. */
  readonly inTransaction: boolean;
  readonly sql: string;
}

export interface RetryLimits {
  readonly maxAttempts: number;
  /**
   * Total wall-clock budget across all attempts.
   *
   * Sits below the 3-second Discord acknowledgement window, so retrying can
   * never be the reason an interaction is lost. Failing fast and saying so
   * beats succeeding after the user has already seen an error.
   */
  readonly deadlineMs: number;
}

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number }
  | { readonly retry: false; readonly reason: string };

export const DEFAULT_RETRY_LIMITS: RetryLimits = { maxAttempts: 3, deadlineMs: 2_000 };

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}

export function isConnectionFailure(error: unknown): boolean {
  const code = codeOf(error);
  return code !== undefined && CONNECTION_FAILURE_CODES.has(code);
}

export function isTransientServerError(error: unknown): boolean {
  const code = codeOf(error);
  return code !== undefined && TRANSIENT_SERVER_CODES.has(code);
}

/**
 * Whether a statement only reads.
 *
 * Conservative on purpose: anything not obviously a read is treated as a write.
 * A false negative costs one un-retried SELECT; a false positive can duplicate
 * an INSERT. `WITH` is excluded because a CTE is allowed to contain
 * `INSERT … RETURNING`, which reads like a query and is not one.
 */
export function isReadOnlyStatement(sql: string): boolean {
  const withoutLeadingComments = sql
    .replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/, "")
    .trimStart();

  return /^(select|show|explain)\b/i.test(withoutLeadingComments);
}

/**
 * Exponential backoff with full jitter, clamped to the remaining budget.
 *
 * Jitter matters more than the curve here: without it, every connection that
 * dropped during a failover retries in lockstep and arrives as a thundering
 * herd at the moment the server is least able to absorb one.
 */
export function backoffDelayMs(
  attempt: number,
  remainingMs: number,
  random: () => number = Math.random,
): number {
  const exponential = Math.min(50 * 2 ** (attempt - 1), 500);
  const jittered = Math.round(random() * exponential);
  return Math.max(0, Math.min(jittered, remainingMs));
}

/**
 * Decides whether a failed query gets another attempt.
 *
 * @param random injected so the jitter is deterministic under test.
 */
export function decideRetry(
  error: unknown,
  context: RetryContext,
  limits: RetryLimits = DEFAULT_RETRY_LIMITS,
  random: () => number = Math.random,
): RetryDecision {
  if (context.attempt >= limits.maxAttempts) {
    return { retry: false, reason: "attempts exhausted" };
  }

  const remainingMs = limits.deadlineMs - context.elapsedMs;
  if (remainingMs <= 0) {
    return { retry: false, reason: "retry deadline reached" };
  }

  if (isConnectionFailure(error)) {
    // Nothing was executed, so this is safe even for a mutation and even
    // mid-transaction — though a transaction will still fail on the next
    // statement, which is correct.
    return { retry: true, delayMs: backoffDelayMs(context.attempt, remainingMs, random) };
  }

  if (isTransientServerError(error)) {
    if (context.inTransaction) {
      // The transaction is already aborted; every further statement will fail
      // until it is rolled back. Retrying here achieves nothing.
      return { retry: false, reason: "inside an aborted transaction" };
    }
    if (!isReadOnlyStatement(context.sql)) {
      return { retry: false, reason: "statement may have applied" };
    }
    return { retry: true, delayMs: backoffDelayMs(context.attempt, remainingMs, random) };
  }

  // A syntax error, a constraint violation, a permission problem — all of these
  // will fail identically on every attempt.
  return { retry: false, reason: "not retryable" };
}
