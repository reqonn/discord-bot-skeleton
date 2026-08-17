/**
 * A declared cache namespace.
 *
 * Cache keys are never free-form strings. Every namespace is declared once in
 * cache.namespaces.ts with an owner and a TTL, and the API takes a namespace
 * rather than a key — so it is not possible to invent a key at a call site, and
 * not possible for two call sites to disagree about how long a value lives.
 *
 * The alternative — `cache.get("tkou:" + guildId, 60000)` — produces a keyspace
 * nobody can enumerate, with TTLs that drift per call site, and no way to
 * answer "who owns this key?" without grepping.
 */
export interface CacheNamespace {
  /** Key prefix. Must be unique across the process. */
  readonly name: string;
  /** The feature or subsystem responsible for invalidating this. */
  readonly owner: string;
  readonly ttlMs: number;
  readonly description: string;
}

/**
 * The cache port.
 *
 * Implementations: in-process (development), Redis (production), and tiered
 * (both). Which one is constructed is decided once in src/app/wiring.ts — no
 * caller knows the difference, which is what makes running without Redis a
 * configuration choice rather than a code path.
 */
export interface Cache {
  get<T>(namespace: CacheNamespace, id: string): Promise<T | undefined>;

  set<T>(namespace: CacheNamespace, id: string, value: T): Promise<void>;

  delete(namespace: CacheNamespace, id: string): Promise<void>;

  /** Drops every entry in a namespace. Used when a write invalidates a whole view. */
  clear(namespace: CacheNamespace): Promise<void>;

  /**
   * Returns the cached value, or computes, stores, and returns it.
   *
   * Concurrent misses on the same key are single-flighted: `load` runs once and
   * every caller receives that result. Without this, a burst of interactions
   * against a cold key produces one database read per interaction, which is
   * precisely when the database can least afford it.
   */
  getOrLoad<T>(namespace: CacheNamespace, id: string, load: () => Promise<T>): Promise<T>;
}
