import { recordCacheHit, recordCacheMiss } from "../context/request-context.js";
import { Metric } from "../metrics/metrics.catalog.js";
import type { Metrics } from "../metrics/metrics.contract.js";

import type { Cache, CacheNamespace } from "./cache.contract.js";

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

/** How often expired entries are swept. Expiry is also checked on read. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * How long an invalidation is remembered once nothing is loading its key.
 *
 * A counter only matters to something that noted it before the invalidation: a
 * `getOrLoad` in flight, or a tiered read holding a mark across one round trip
 * to the far tier. Both last seconds. Ten minutes is far past either, so
 * forgetting a counter that old cannot let a stale answer be written back —
 * while keeping them forever would be one integer per key ever invalidated,
 * for the life of the process.
 */
const GENERATION_KEEP_MS = 10 * 60_000;

/**
 * In-process cache.
 *
 * The whole cache in development, and the L1 tier in production. Values are
 * stored by reference rather than serialised — this is a cache, not an IPC
 * boundary, and a structured clone per read would cost more than the lookup
 * saves. Callers must treat what they get back as immutable.
 *
 * Entries expire lazily on read, with a periodic sweep so a namespace that
 * stops being read does not pin memory forever.
 */
export class MemoryCache implements Cache {
  private readonly entries = new Map<string, Entry>();
  /** In-flight loads, so concurrent misses on one key produce one load. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  /**
   * How many times each key has been invalidated.
   *
   * Read before a load starts and compared after it finishes, so an answer
   * that predates a `delete` is returned to its caller but never stored. See
   * `getOrLoad`.
   */
  private readonly generations = new Map<string, number>();

  /** When each key's generation last moved, so the sweep knows when to forget it. */
  private readonly bumpedAt = new Map<string, number>();

  /**
   * How many times each namespace has been cleared wholesale.
   *
   * Separate from `generations` because a clear invalidates keys that have
   * never been seen — including the one a first-ever load is fetching right
   * now, which has no generation of its own to bump.
   */
  private readonly cleared = new Map<string, number>();
  private sweeper: NodeJS.Timeout | undefined;

  constructor(
    private readonly metrics: Metrics,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.sweeper !== undefined) return;
    this.sweeper = setInterval(() => {
      this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  stop(): void {
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    this.sweeper = undefined;
    this.entries.clear();
    this.inFlight.clear();
    this.generations.clear();
    this.bumpedAt.clear();
    this.cleared.clear();
  }

  get<T>(namespace: CacheNamespace, id: string): Promise<T | undefined> {
    const entry = this.entries.get(keyFor(namespace, id));

    if (entry === undefined || entry.expiresAt <= this.now()) {
      if (entry !== undefined) this.entries.delete(keyFor(namespace, id));
      this.recordMiss(namespace);
      return Promise.resolve(undefined);
    }

    this.recordHit(namespace);
    return Promise.resolve(entry.value as T);
  }

  set<T>(namespace: CacheNamespace, id: string, value: T): Promise<void> {
    this.entries.set(keyFor(namespace, id), {
      value,
      expiresAt: this.now() + namespace.ttlMs,
    });
    return Promise.resolve();
  }

  delete(namespace: CacheNamespace, id: string): Promise<void> {
    const key = keyFor(namespace, id);
    this.entries.delete(key);
    // Tells any load already in flight that its answer is now stale. See
    // `getOrLoad`.
    this.bump(key);
    return Promise.resolve();
  }

  clear(namespace: CacheNamespace): Promise<void> {
    const prefix = `${namespace.name}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
    // Every in-flight load for this namespace is stale too, and it may be
    // loading a key that has no entry and no generation yet — a first-ever
    // load, which is exactly what a cold cache is full of. So bump the
    // *namespace*, and let a load compare against that as well as its own key.
    this.cleared.set(namespace.name, (this.cleared.get(namespace.name) ?? 0) + 1);
    return Promise.resolve();
  }

  getOrLoad<T>(namespace: CacheNamespace, id: string, load: () => Promise<T>): Promise<T> {
    const key = keyFor(namespace, id);

    // Read synchronously, and the generation with it. An `await` here would
    // yield a microtask in which an invalidation could land *before* this call
    // has noted which generation it belongs to — and the load would then look
    // current when it is not. The entry lookup needs no I/O, so there is
    // nothing to wait for.
    const entry = this.entries.get(key);
    if (entry !== undefined && entry.expiresAt > this.now()) {
      this.recordHit(namespace);
      return Promise.resolve(entry.value as T);
    }
    if (entry !== undefined) this.entries.delete(key);
    this.recordMiss(namespace);

    // Join an in-flight load rather than starting a second one. This is the
    // difference between one database read and fifty when a hot key expires
    // during a burst.
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return existing as Promise<T>;

    // Read before the load starts, compared after it finishes. A `delete` or a
    // `clear` arriving in between bumps one of them, and the answer this load
    // is carrying is then known to predate the change — so it is returned to
    // the caller who asked for it and *not* written back.
    //
    // Without this the write was unconditional, and it silently undid the
    // invalidation: the value the invalidation removed reappeared and lived
    // for the whole TTL.
    const mark = this.markLoad(namespace, id);

    const pending = load()
      .then(async (value) => {
        if (this.isCurrent(namespace, id, mark)) await this.set(namespace, id, value);
        return value;
      })
      .finally(() => {
        // Cleared even on failure, so a transient error does not poison the
        // key for every later caller.
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, pending);
    return pending;
  }

  /**
   * What the invalidation state was when a load began.
   *
   * Taken *before* the load rather than inside it: by the time a loader has
   * been invoked, an invalidation may already have landed, and a check that
   * reads the generation at that point compares two post-delete values and
   * calls a stale answer current.
   *
   * Public because `TieredCache` holds one across its round trip to the shared
   * tier, which is a gap this cache cannot see.
   */
  markLoad(namespace: CacheNamespace, id: string): LoadMark {
    return {
      generation: this.generations.get(keyFor(namespace, id)) ?? 0,
      clears: this.cleared.get(namespace.name) ?? 0,
    };
  }

  /** Whether nothing invalidated this key since `markLoad`. */
  isCurrent(namespace: CacheNamespace, id: string, mark: LoadMark): boolean {
    return (
      (this.generations.get(keyFor(namespace, id)) ?? 0) === mark.generation &&
      (this.cleared.get(namespace.name) ?? 0) === mark.clears
    );
  }

  /** Entry count, for tests and diagnostics. */
  get size(): number {
    return this.entries.size;
  }

  /** How many invalidation counters are held. For tests and diagnostics. */
  get trackedGenerations(): number {
    return this.generations.size;
  }

  private bump(key: string): void {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.bumpedAt.set(key, this.now());
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }

    // Kept while a load that began before the bump may still be running, and
    // for as long as any mark could still be held. Without this the counters
    // are one integer per key ever invalidated, held for the life of the
    // process. See `GENERATION_KEEP_MS`.
    for (const [key, at] of this.bumpedAt) {
      if (now - at < GENERATION_KEEP_MS || this.inFlight.has(key)) continue;
      this.generations.delete(key);
      this.bumpedAt.delete(key);
    }
  }

  private recordHit(namespace: CacheNamespace): void {
    this.metrics.increment(Metric.cacheOperationTotal, {
      tier: "memory",
      outcome: "hit",
      namespace: namespace.name,
    });
    recordCacheHit();
  }

  private recordMiss(namespace: CacheNamespace): void {
    this.metrics.increment(Metric.cacheOperationTotal, {
      tier: "memory",
      outcome: "miss",
      namespace: namespace.name,
    });
    recordCacheMiss();
  }
}

export function keyFor(namespace: CacheNamespace, id: string): string {
  return `${namespace.name}:${id}`;
}

/**
 * A key's invalidation state at one moment.
 *
 * Two counters rather than one: a `delete` bumps the key's generation, and a
 * `clear` bumps the namespace's — and a load for a key that has never been
 * cached has no generation of its own to bump.
 */
export interface LoadMark {
  readonly generation: number;
  readonly clears: number;
}
