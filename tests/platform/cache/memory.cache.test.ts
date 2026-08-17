import { describe, expect, it, vi } from "vitest";

import type { CacheNamespace } from "#platform/cache/cache.contract.js";
import { MemoryCache } from "#platform/cache/memory.cache.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

const NS: CacheNamespace = {
  name: "test:thing",
  owner: "test",
  ttlMs: 1_000,
  description: "A thing.",
};

const OTHER: CacheNamespace = { ...NS, name: "test:other" };

function cacheWithClock(): { cache: MemoryCache; advance: (ms: number) => void } {
  let now = 0;
  const cache = new MemoryCache(new MetricsRegistry(), () => now);
  return {
    cache,
    advance: (ms) => {
      now += ms;
    },
  };
}

describe("MemoryCache", () => {
  it("returns undefined for an unknown key", async () => {
    const { cache } = cacheWithClock();

    await expect(cache.get(NS, "missing")).resolves.toBeUndefined();
  });

  it("round-trips a value", async () => {
    const { cache } = cacheWithClock();
    await cache.set(NS, "a", { count: 3 });

    await expect(cache.get(NS, "a")).resolves.toEqual({ count: 3 });
  });

  it("keeps namespaces separate", async () => {
    const { cache } = cacheWithClock();
    await cache.set(NS, "a", "first");
    await cache.set(OTHER, "a", "second");

    await expect(cache.get(NS, "a")).resolves.toBe("first");
    await expect(cache.get(OTHER, "a")).resolves.toBe("second");
  });

  it("deletes a single entry", async () => {
    const { cache } = cacheWithClock();
    await cache.set(NS, "a", 1);
    await cache.delete(NS, "a");

    await expect(cache.get(NS, "a")).resolves.toBeUndefined();
  });

  it("clears one namespace without touching another", async () => {
    const { cache } = cacheWithClock();
    await cache.set(NS, "a", 1);
    await cache.set(OTHER, "b", 2);

    await cache.clear(NS);

    await expect(cache.get(NS, "a")).resolves.toBeUndefined();
    await expect(cache.get(OTHER, "b")).resolves.toBe(2);
  });

  describe("expiry", () => {
    it("expires an entry once its namespace TTL passes", async () => {
      const { cache, advance } = cacheWithClock();
      await cache.set(NS, "a", "value");

      advance(999);
      await expect(cache.get(NS, "a")).resolves.toBe("value");

      advance(2);
      await expect(cache.get(NS, "a")).resolves.toBeUndefined();
    });

    it("drops the expired entry rather than leaving it in memory", async () => {
      const { cache, advance } = cacheWithClock();
      await cache.set(NS, "a", "value");
      advance(1_001);

      await cache.get(NS, "a");

      expect(cache.size).toBe(0);
    });
  });

  describe("getOrLoad", () => {
    it("loads and caches on a miss", async () => {
      const { cache } = cacheWithClock();
      const load = vi.fn().mockResolvedValue("loaded");

      await expect(cache.getOrLoad(NS, "a", load)).resolves.toBe("loaded");
      await expect(cache.getOrLoad(NS, "a", load)).resolves.toBe("loaded");

      expect(load).toHaveBeenCalledTimes(1);
    });

    it("single-flights concurrent misses on the same key", async () => {
      const { cache } = cacheWithClock();
      let resolveLoad!: (value: string) => void;
      const load = vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveLoad = resolve;
          }),
      );

      // Ten simultaneous misses on a cold key must produce one database read,
      // not ten — this is the stampede the cache exists to prevent.
      const waiting = Array.from({ length: 10 }, () => cache.getOrLoad(NS, "a", load));
      // getOrLoad checks the cache before loading, so let those microtasks
      // settle before releasing the loader.
      await new Promise((tick) => setTimeout(tick, 0));
      resolveLoad("loaded");

      await expect(Promise.all(waiting)).resolves.toEqual(Array<string>(10).fill("loaded"));
      expect(load).toHaveBeenCalledTimes(1);
    });

    it("does not single-flight different keys", async () => {
      const { cache } = cacheWithClock();
      const load = vi.fn().mockResolvedValue("x");

      await Promise.all([cache.getOrLoad(NS, "a", load), cache.getOrLoad(NS, "b", load)]);

      expect(load).toHaveBeenCalledTimes(2);
    });

    it("propagates a load failure without caching it", async () => {
      const { cache } = cacheWithClock();
      const load = vi
        .fn()
        .mockRejectedValueOnce(new Error("database down"))
        .mockResolvedValueOnce("recovered");

      await expect(cache.getOrLoad(NS, "a", load)).rejects.toThrow("database down");
      // A transient failure must not poison the key for every later caller.
      await expect(cache.getOrLoad(NS, "a", load)).resolves.toBe("recovered");
    });

    it("caches a falsy value", async () => {
      const { cache } = cacheWithClock();
      const load = vi.fn().mockResolvedValue(0);

      await cache.getOrLoad(NS, "a", load);
      await cache.getOrLoad(NS, "a", load);

      // `0` and `false` are real cached values; only `undefined` means absent.
      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  it("records hits and misses as metrics", async () => {
    const metrics = new MetricsRegistry();
    const cache = new MemoryCache(metrics);

    await cache.get(NS, "a");
    await cache.set(NS, "a", 1);
    await cache.get(NS, "a");

    const output = metrics.render();
    expect(output).toContain('outcome="miss"');
    expect(output).toContain('outcome="hit"');
  });

  it("releases everything on stop", async () => {
    const { cache } = cacheWithClock();
    cache.start();
    await cache.set(NS, "a", 1);

    cache.stop();

    expect(cache.size).toBe(0);
  });
});
