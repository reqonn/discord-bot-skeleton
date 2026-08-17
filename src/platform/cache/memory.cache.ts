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
    this.entries.delete(keyFor(namespace, id));
    return Promise.resolve();
  }

  clear(namespace: CacheNamespace): Promise<void> {
    const prefix = `${namespace.name}:`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
    return Promise.resolve();
  }

  async getOrLoad<T>(namespace: CacheNamespace, id: string, load: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(namespace, id);
    if (cached !== undefined) return cached;

    const key = keyFor(namespace, id);

    // Join an in-flight load rather than starting a second one. This is the
    // difference between one database read and fifty when a hot key expires
    // during a burst.
    const existing = this.inFlight.get(key);
    if (existing !== undefined) return (await existing) as T;

    const pending = load();
    this.inFlight.set(key, pending);

    try {
      const value = await pending;
      await this.set(namespace, id, value);
      return value;
    } finally {
      // Cleared even on failure, so a transient error does not poison the key
      // for every later caller.
      this.inFlight.delete(key);
    }
  }

  /** Entry count, for tests and diagnostics. */
  get size(): number {
    return this.entries.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
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
