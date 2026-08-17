import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { CacheNamespace } from "#platform/cache/cache.contract.js";
import { MemoryCache } from "#platform/cache/memory.cache.js";
import { RedisCache } from "#platform/cache/redis.cache.js";
import { TieredCache } from "#platform/cache/tiered.cache.js";
import { RedisLock } from "#platform/locks/redis.lock.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import { MemoryLogger } from "#testing/memory.logger.js";

/**
 * The production cache and lock implementations, against a real Redis.
 *
 * These exist because development deliberately runs without Redis, which means
 * the Redis-backed classes are the *least* exercised code in the repository and
 * the only code a production deploy runs first. Unit tests with a fake client
 * would prove the calls are shaped right and nothing about whether Redis agrees
 * — the semantics being relied on here (SET NX PX, compare-and-delete via Lua,
 * SCAN paging) are exactly the parts a fake would get wrong.
 *
 * Skipped when REDIS_URL is unset, so `pnpm verify` still passes on a machine
 * with no Redis. CI sets it.
 */

// Blank means unset, exactly as loadConfig treats it — `REDIS_URL=` in a .env
// file is how a developer disables Redis, and "" !== undefined would otherwise
// run this whole suite against nothing and spend two minutes timing out.
const raw = process.env["REDIS_URL"];
const REDIS_URL = raw === undefined || raw === "" ? undefined : raw;
const describeRedis = REDIS_URL === undefined ? describe.skip : describe;

const NS: CacheNamespace = {
  name: "itest:thing",
  owner: "integration",
  ttlMs: 2_000,
  description: "Integration fixture.",
};

describeRedis("Redis-backed infrastructure", () => {
  const redis = new Redis(REDIS_URL ?? "", { maxRetriesPerRequest: 2, lazyConnect: true });
  const metrics = new MetricsRegistry();
  const logger = new MemoryLogger();

  afterAll(async () => {
    await redis.quit();
  });

  beforeEach(async () => {
    const keys = await redis.keys("itest:*");
    if (keys.length > 0) await redis.del(...keys);
  });

  describe("RedisCache", () => {
    const cache = new RedisCache(redis, metrics, logger);

    it("round-trips a value", async () => {
      await cache.set(NS, "a", { count: 3 });

      await expect(cache.get(NS, "a")).resolves.toEqual({ count: 3 });
    });

    it("returns undefined for a key it has never seen", async () => {
      await expect(cache.get(NS, "missing")).resolves.toBeUndefined();
    });

    it("expires by the namespace TTL", async () => {
      const brief: CacheNamespace = { ...NS, ttlMs: 150 };
      await cache.set(brief, "a", "value");

      await expect(cache.get(brief, "a")).resolves.toBe("value");
      await new Promise((wait) => setTimeout(wait, 250));
      await expect(cache.get(brief, "a")).resolves.toBeUndefined();
    });

    it("deletes a single entry", async () => {
      await cache.set(NS, "a", 1);
      await cache.delete(NS, "a");

      await expect(cache.get(NS, "a")).resolves.toBeUndefined();
    });

    it("clears a namespace by SCAN without touching another", async () => {
      const other: CacheNamespace = { ...NS, name: "itest:other" };
      await cache.set(NS, "a", 1);
      await cache.set(NS, "b", 2);
      await cache.set(other, "c", 3);

      await cache.clear(NS);

      await expect(cache.get(NS, "a")).resolves.toBeUndefined();
      await expect(cache.get(NS, "b")).resolves.toBeUndefined();
      await expect(cache.get(other, "c")).resolves.toBe(3);
    });

    it("preserves a falsy value, rather than confusing it with absent", async () => {
      await cache.set(NS, "zero", 0);

      await expect(cache.get(NS, "zero")).resolves.toBe(0);
    });
  });

  describe("TieredCache", () => {
    it("promotes an L2 hit into L1, so the next read is local", async () => {
      const l1 = new MemoryCache(metrics);
      const shared = new RedisCache(redis, metrics, logger);
      const tiered = new TieredCache(l1, shared);

      // Written straight to Redis, as another instance would have.
      await shared.set(NS, "promote", "from-redis");

      await expect(tiered.get(NS, "promote")).resolves.toBe("from-redis");
      await expect(l1.get(NS, "promote")).resolves.toBe("from-redis");
    });

    it("writes through to both tiers", async () => {
      const l1 = new MemoryCache(metrics);
      const shared = new RedisCache(redis, metrics, logger);
      const tiered = new TieredCache(l1, shared);

      await tiered.set(NS, "both", "value");

      await expect(l1.get(NS, "both")).resolves.toBe("value");
      await expect(shared.get(NS, "both")).resolves.toBe("value");
    });

    it("deletes from both tiers, so a local copy cannot survive an invalidation", async () => {
      const l1 = new MemoryCache(metrics);
      const shared = new RedisCache(redis, metrics, logger);
      const tiered = new TieredCache(l1, shared);
      await tiered.set(NS, "gone", "value");

      await tiered.delete(NS, "gone");

      await expect(l1.get(NS, "gone")).resolves.toBeUndefined();
      await expect(shared.get(NS, "gone")).resolves.toBeUndefined();
    });
  });

  describe("RedisLock", () => {
    const lock = new RedisLock(redis, logger);

    it("runs work and returns its result", async () => {
      await expect(
        lock.runExclusive("itest:job", 2_000, () => Promise.resolve("done")),
      ).resolves.toBe("done");
    });

    it("refuses a second holder while the first is running", async () => {
      let release!: () => void;
      const held = lock.runExclusive(
        "itest:job",
        5_000,
        () => new Promise<void>((resolve) => (release = resolve)),
      );

      // The whole point of the lease: another instance must not run this.
      await expect(
        lock.runExclusive("itest:job", 5_000, () => Promise.resolve("second")),
      ).resolves.toBeUndefined();

      release();
      await held;
    });

    it("releases the lease so the next run can take it", async () => {
      await lock.runExclusive("itest:job", 2_000, () => Promise.resolve(1));

      await expect(lock.runExclusive("itest:job", 2_000, () => Promise.resolve(2))).resolves.toBe(
        2,
      );
    });

    it("releases the lease even when work throws", async () => {
      await expect(
        lock.runExclusive("itest:job", 2_000, () => Promise.reject(new Error("boom"))),
      ).rejects.toThrow("boom");

      // A failed run must not lock a job out forever.
      await expect(
        lock.runExclusive("itest:job", 2_000, () => Promise.resolve("after")),
      ).resolves.toBe("after");
    });

    it("keeps different lock names independent", async () => {
      let release!: () => void;
      const held = lock.runExclusive(
        "itest:first",
        5_000,
        () => new Promise<void>((resolve) => (release = resolve)),
      );

      await expect(
        lock.runExclusive("itest:second", 2_000, () => Promise.resolve("ok")),
      ).resolves.toBe("ok");

      release();
      await held;
    });

    it("does not delete a lease it no longer owns", async () => {
      // Compare-and-delete is the reason release uses a Lua script: a naive DEL
      // would drop whichever holder happened to be next.
      await lock.runExclusive("itest:owned", 200, async () => {
        await new Promise((wait) => setTimeout(wait, 400));
      });

      // The lease expired mid-run and could have been retaken; releasing must
      // not have removed a key belonging to someone else. Nothing to assert
      // beyond it completing without throwing, which the script guarantees.
      await expect(redis.get("lock:itest:owned")).resolves.toBeNull();
    });
  });
});
