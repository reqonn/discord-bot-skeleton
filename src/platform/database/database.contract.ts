/**
 * The database port.
 *
 * Repository implementations depend on this, never on `pg` directly. That is
 * not ceremony: it is what lets a repository be exercised against a fake in a
 * unit test and against real PostgreSQL in an integration test, using the same
 * code path.
 *
 * Deliberately narrow. There is no query builder and no schema abstraction —
 * repositories write SQL, because SQL is the thing being tested and hiding it
 * behind a builder only moves where the bugs live.
 */
export interface Queryable {
  /** Rows matching the query. Empty array when nothing matched. */
  query<TRow>(sql: string, params?: readonly unknown[]): Promise<TRow[]>;

  /**
   * The single row matching the query, or undefined.
   * Throws when more than one row comes back: a caller asking for one row and
   * silently receiving the first of many is a bug that hides for months.
   */
  queryOne<TRow>(sql: string, params?: readonly unknown[]): Promise<TRow | undefined>;

  /** Runs a statement for its effect. Returns the number of rows affected. */
  execute(sql: string, params?: readonly unknown[]): Promise<number>;
}

/**
 * A queryable bound to an open transaction.
 *
 * Repositories accept this as an optional final argument, so a use case can
 * compose several repository calls into one atomic write without any of them
 * knowing a transaction exists.
 */
export type Transaction = Queryable;

export interface Database extends Queryable {
  /**
   * Runs `work` inside a transaction, committing on return and rolling back on
   * throw.
   *
   * Never hold one of these open across a Discord API call. The two systems do
   * not share a transaction, the API call can take seconds, and a connection
   * held that long starves the pool. Write to Discord first and compensate on
   * failure — see docs/architecture.md § Transactions.
   */
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;

  /**
   * Runs `work` against one pinned connection, without opening a transaction.
   *
   * Needed wherever PostgreSQL state is session-scoped rather than statement-
   * scoped — session advisory locks, most obviously, which the migration
   * runner relies on. Taking such a lock through the pool would acquire it on
   * one connection and release it on another.
   *
   * Prefer `transaction` for ordinary work. Reach for this only when session
   * scope is the actual requirement.
   */
  withSession<T>(work: (session: Queryable) => Promise<T>): Promise<T>;

  /** Live pool state, for metrics and readiness. */
  stats(): PoolStats;
}

export interface PoolStats {
  readonly total: number;
  readonly idle: number;
  /** Requests queued because every connection is busy. Sustained non-zero means the pool is too small. */
  readonly waiting: number;
}
