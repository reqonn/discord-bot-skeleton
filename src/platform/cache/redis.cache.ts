import type { Redis } from "ioredis";

import { recordCacheHit, recordCacheMiss } from "../context/request-context.js";
import type { Logger } from "../logging/logger.contract.js";
import { Metric } from "../metrics/metrics.catalog.js";
import type { Metrics } from "../metrics/metrics.contract.js";

import type { Cache, CacheNamespace } from "./cache.contract.js";
import { keyFor } from "./memory.cache.js";

/** Batch size for the SCAN used by `clear`. Large enough to be quick, small enough not to block. */
const SCAN_COUNT = 200;

/**
 * Redis-backed cache.
 *
 * Every operation fails soft: a cache is an optimisation, and a Redis outage
 * should degrade the bot to "slower" rather than "broken". A failed read is
 * reported as a miss and a failed write is dropped, both with a log line, so
 * the outage is visible without being fatal.
 */
export class RedisCache implements Cache {
  private readonly logger: Logger;

  constructor(
    private readonly redis: Redis,
    private readonly metrics: Metrics,
    logger: Logger,
  ) {
    this.logger = logger.child({ subsystem: "cache", tier: "redis" });
  }

  async get<T>(namespace: CacheNamespace, id: string): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(keyFor(namespace, id));
      if (raw === null) {
        this.record(namespace, "miss");
        return undefined;
      }
      this.record(namespace, "hit");
      return JSON.parse(raw) as T;
    } catch (error) {
      this.logger.warn("Cache read failed; treating as a miss", {
        error,
        namespace: namespace.name,
      });
      this.record(namespace, "miss");
      return undefined;
    }
  }

  async set<T>(namespace: CacheNamespace, id: string, value: T): Promise<void> {
    try {
      await this.redis.set(keyFor(namespace, id), JSON.stringify(value), "PX", namespace.ttlMs);
    } catch (error) {
      this.logger.warn("Cache write failed; continuing uncached", {
        error,
        namespace: namespace.name,
      });
    }
  }

  async delete(namespace: CacheNamespace, id: string): Promise<void> {
    try {
      await this.redis.del(keyFor(namespace, id));
    } catch (error) {
      // A failed invalidation is the one failure that is not harmless: the
      // stale value survives until its TTL. Log it loudly.
      this.logger.error("Cache invalidation failed; a stale value may be served until its TTL", {
        error,
        namespace: namespace.name,
      });
    }
  }

  async clear(namespace: CacheNamespace): Promise<void> {
    const pattern = `${namespace.name}:*`;
    let cursor = "0";

    try {
      do {
        // SCAN rather than KEYS: KEYS blocks the Redis server for the whole
        // keyspace, which on a shared instance is everyone's problem.
        const [next, keys] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT);
        cursor = next;
        if (keys.length > 0) await this.redis.del(...keys);
      } while (cursor !== "0");
    } catch (error) {
      this.logger.error("Cache clear failed", { error, namespace: namespace.name });
    }
  }

  async getOrLoad<T>(namespace: CacheNamespace, id: string, load: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(namespace, id);
    if (cached !== undefined) return cached;

    const value = await load();
    await this.set(namespace, id, value);
    return value;
  }

  private record(namespace: CacheNamespace, outcome: "hit" | "miss"): void {
    this.metrics.increment(Metric.cacheOperationTotal, {
      tier: "redis",
      outcome,
      namespace: namespace.name,
    });
    if (outcome === "hit") recordCacheHit();
    else recordCacheMiss();
  }
}
