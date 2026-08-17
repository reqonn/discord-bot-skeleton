import pg from "pg";

import { InfrastructureError } from "../../shared/errors/app-error.js";
import type { Config } from "../config/config.js";
import { recordQuery } from "../context/request-context.js";
import type { Logger } from "../logging/logger.contract.js";
import { Metric } from "../metrics/metrics.catalog.js";
import type { Metrics } from "../metrics/metrics.contract.js";

import type { Database, PoolStats, Queryable, Transaction } from "./database.contract.js";
import { decideRetry, type RetryLimits } from "./retry.policy.js";

/**
 * Queries slower than this are logged individually with their SQL.
 * Set well under the Discord ack budget so a slow query is visible long before
 * it starts costing interactions.
 */
const SLOW_QUERY_MS = 200;

/**
 * PostgreSQL adapter.
 *
 * Three things it does beyond forwarding to `pg`:
 *
 *   1. Instruments every query — duration into a histogram, count into the
 *      active request context. That is what makes "this command issued 14
 *      queries" answerable.
 *   2. Sets `statement_timeout` on every connection, so a pathological query
 *      fails fast instead of burning the interaction budget.
 *   3. Wraps driver errors in InfrastructureError, so a connection string
 *      never reaches a user-facing message.
 */
export class PgDatabase implements Database {
  private readonly pool: pg.Pool;
  private closed = false;
  private readonly logger: Logger;
  private readonly retryLimits: RetryLimits;

  constructor(
    config: Config,
    logger: Logger,
    private readonly metrics: Metrics,
  ) {
    this.logger = logger.child({ subsystem: "database" });
    this.retryLimits = { maxAttempts: 3, deadlineMs: config.database.retryDeadlineMs };
    this.pool = new pg.Pool({
      connectionString: config.database.url,
      min: config.database.poolMin,
      max: config.database.poolMax,
      // Applied per connection by the driver, so every statement inherits it
      // without repeating the setting at call sites.
      statement_timeout: config.database.statementTimeoutMs,
    });

    // An idle-client error (a server restart, a dropped connection) is emitted
    // on the pool, and an unhandled 'error' event would take the process down.
    this.pool.on("error", (error) => {
      this.logger.warn("Idle database client errored", { error });
    });
  }

  /**
   * Opens the configured minimum number of connections.
   *
   * Without this the first command after a deploy pays TCP, TLS, and auth
   * inside its 3-second budget — which is exactly when the bot is being
   * watched most closely.
   */
  async warmUp(): Promise<void> {
    await this.query("SELECT 1");
    this.logger.debug("Database pool warmed", { ...this.stats() });
  }

  query<TRow>(sql: string, params: readonly unknown[] = []): Promise<TRow[]> {
    return this.run(this.pool, sql, params);
  }

  async queryOne<TRow>(sql: string, params: readonly unknown[] = []): Promise<TRow | undefined> {
    const rows = await this.run<TRow>(this.pool, sql, params);
    return firstOfAtMostOne(rows, sql);
  }

  async execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    return this.runForCount(this.pool, sql, params);
  }

  async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const client = await this.connect();
    const tx = new PgTransaction(client, this);

    try {
      await client.query("BEGIN");
      const result = await work(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // A rollback failure must not mask the error that caused it.
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        this.logger.error("Rollback failed", { error: rollbackError });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async withSession<T>(work: (session: Queryable) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await work(new PgTransaction(client, this));
    } finally {
      client.release();
    }
  }

  stats(): PoolStats {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };
  }

  /** Publishes pool state. Called on the metrics sampling interval. */
  publishPoolMetrics(): void {
    const stats = this.stats();
    this.metrics.setGauge(Metric.databasePoolConnections, stats.total, { state: "total" });
    this.metrics.setGauge(Metric.databasePoolConnections, stats.idle, { state: "idle" });
    this.metrics.setGauge(Metric.databasePoolConnections, stats.waiting, { state: "waiting" });
  }

  /**
   * Closes the pool. Safe to call more than once.
   *
   * `pg` throws "Called end on pool more than once", and closing twice is a
   * reachable state: a failed boot runs the shutdown sequence, and a signal
   * arriving during that would otherwise turn a clean teardown into a logged
   * "shutdown step failed" in the middle of an already-bad moment.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }

  private async connect(): Promise<pg.PoolClient> {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw new InfrastructureError("Could not acquire a database connection", { cause: error });
    }
  }

  /** Shared by the pool and by transaction clients, so both are instrumented identically. */
  async run<TRow>(
    executor: Pick<pg.Pool, "query">,
    sql: string,
    params: readonly unknown[],
    inTransaction = false,
  ): Promise<TRow[]> {
    const result = await this.instrument(executor, sql, params, inTransaction);
    return result.rows as TRow[];
  }

  async runForCount(
    executor: Pick<pg.Pool, "query">,
    sql: string,
    params: readonly unknown[],
    inTransaction = false,
  ): Promise<number> {
    const result = await this.instrument(executor, sql, params, inTransaction);
    return result.rowCount ?? 0;
  }

  /**
   * Runs a statement, retrying it when the failure says it is safe to.
   *
   * The retry decision lives in retry.policy.ts and is a pure function, so the
   * rules — which failures, which statements, how long — are testable without a
   * database. Everything here is the mechanics of applying that decision.
   *
   * Timing is measured across all attempts, because what matters is how long
   * the caller waited, not how long the successful attempt took.
   */
  private async instrument(
    executor: Pick<pg.Pool, "query">,
    sql: string,
    params: readonly unknown[],
    inTransaction: boolean,
  ): Promise<pg.QueryResult> {
    const startedAt = performance.now();

    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await executor.query(sql, params as unknown[]);
        this.observe(startedAt, sql, "ok");
        return result;
      } catch (error) {
        const elapsedMs = performance.now() - startedAt;
        const decision = decideRetry(
          error,
          { attempt, elapsedMs, inTransaction, sql },
          this.retryLimits,
        );

        if (!decision.retry) {
          this.observe(startedAt, sql, "failed");
          // The driver's message can contain parameter values, and the
          // connection string is on the error for connection failures. Neither
          // belongs anywhere a user can see, so it becomes `detail` on an
          // InfrastructureError.
          throw new InfrastructureError(`Query failed: ${summarise(sql)}`, {
            cause: error,
            meta: { sql: summarise(sql), attempts: attempt, notRetried: decision.reason },
          });
        }

        this.metrics.increment(Metric.databaseQueryRetryTotal, { code: codeOf(error) });
        this.logger.warn("Retrying query", {
          attempt,
          delayMs: decision.delayMs,
          code: codeOf(error),
          sql: summarise(sql),
        });

        await sleep(decision.delayMs);
      }
    }
  }

  private observe(startedAt: number, sql: string, outcome: "ok" | "failed"): void {
    const durationMs = performance.now() - startedAt;

    this.metrics.observe(Metric.databaseQueryDurationMs, durationMs);
    this.metrics.increment(Metric.databaseQueryTotal, { outcome });
    recordQuery(durationMs);

    if (durationMs > SLOW_QUERY_MS) {
      this.logger.warn("Slow query", { durationMs: Math.round(durationMs), sql: summarise(sql) });
    }
  }
}

/** A Queryable bound to one client for the life of a transaction. */
class PgTransaction implements Queryable {
  constructor(
    private readonly client: pg.PoolClient,
    private readonly database: PgDatabase,
  ) {}

  query<TRow>(sql: string, params: readonly unknown[] = []): Promise<TRow[]> {
    return this.database.run<TRow>(this.client, sql, params, true);
  }

  async queryOne<TRow>(sql: string, params: readonly unknown[] = []): Promise<TRow | undefined> {
    return firstOfAtMostOne(await this.database.run<TRow>(this.client, sql, params, true), sql);
  }

  execute(sql: string, params: readonly unknown[] = []): Promise<number> {
    return this.database.runForCount(this.client, sql, params, true);
  }
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** The driver code, as a metric label. Bounded cardinality by construction. */
function codeOf(error: unknown): string {
  if (typeof error !== "object" || error === null) return "unknown";
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : "unknown";
}

function firstOfAtMostOne<TRow>(rows: TRow[], sql: string): TRow | undefined {
  if (rows.length > 1) {
    throw new InfrastructureError(
      `queryOne matched ${String(rows.length)} rows: ${summarise(sql)}. Add a constraint to the query, or use query().`,
    );
  }
  return rows[0];
}

/** One-line, length-capped SQL for logs and error detail. */
function summarise(sql: string): string {
  const collapsed = sql.replace(/\s+/g, " ").trim();
  return collapsed.length > 160 ? `${collapsed.slice(0, 157)}...` : collapsed;
}
