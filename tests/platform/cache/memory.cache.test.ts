import { afterEach, describe, expect, it, vi } from "vitest";

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

    describe("invalidation during a load", () => {
      it("does not write back an answer older than a delete", async () => {
        // The load began before the delete, so what it is carrying predates
        // the change. Writing it back silently undoes the invalidation, and
        // the stale value then lives for the whole TTL.
        //
        // Where it bites: a premium claim commits, the tier cache is
        // invalidated, and a tier read that started before the commit finishes
        // afterwards and restores the pre-claim tier. A server that has just
        // paid reads as unpaid until the TTL lapses.
        const { cache } = cacheWithClock();
        let release!: (value: string) => void;
        const load = () =>
          new Promise<string>((resolve) => {
            release = resolve;
          });

        const inFlight = cache.getOrLoad(NS, "a", load);
        await new Promise((tick) => setTimeout(tick, 0));

        await cache.delete(NS, "a");
        release("stale");

        // The caller who asked still gets the answer they asked for.
        await expect(inFlight).resolves.toBe("stale");
        // But it must not have been cached.
        await expect(cache.get(NS, "a")).resolves.toBeUndefined();
      });

      it("does not write back an answer older than a clear", async () => {
        // A clear invalidates keys that have never been seen — including the
        // one a first-ever load is fetching right now, which has no per-key
        // generation to compare against. A cold cache is full of exactly that
        // case, so the namespace needs a counter of its own.
        const { cache } = cacheWithClock();
        let release!: (value: string) => void;
        const load = () =>
          new Promise<string>((resolve) => {
            release = resolve;
          });

        const inFlight = cache.getOrLoad(NS, "a", load);
        await new Promise((tick) => setTimeout(tick, 0));

        await cache.clear(NS);
        release("stale");

        await expect(inFlight).resolves.toBe("stale");
        await expect(cache.get(NS, "a")).resolves.toBeUndefined();
      });

      it("still caches an answer nothing invalidated", async () => {
        // The guard must not be so broad that it stops the cache caching.
        const { cache } = cacheWithClock();
        const load = vi.fn().mockResolvedValue("fresh");

        await cache.getOrLoad(NS, "a", load);
        await cache.getOrLoad(NS, "a", load);

        expect(load).toHaveBeenCalledTimes(1);
      });
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

  describe("forgetting invalidations", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("forgets a counter once nothing could still be comparing against it", async () => {
      // The counters are one integer per key ever invalidated. Without the
      // sweep they are kept for the life of the process, which on a busy bot
      // is every guild, user and channel that ever changed a setting.
      vi.useFakeTimers();
      const { cache, advance } = cacheWithClock();
      cache.start();

      for (let index = 0; index < 5; index += 1) await cache.delete(NS, `k${String(index)}`);
      expect(cache.trackedGenerations).toBe(5);

      // Past the keep window on the cache's clock, then let the sweeper fire.
      advance(11 * 60_000);
      vi.advanceTimersByTime(60_000);

      expect(cache.trackedGenerations).toBe(0);
      cache.stop();
    });

    it("keeps a counter a load is still going to compare against", async () => {
      // And not while a load that began before the bump is still running: the
      // invalidation must still win when that load finishes.
      vi.useFakeTimers();
      const { cache, advance } = cacheWithClock();
      cache.start();
      let release!: (value: string) => void;

      const inFlight = cache.getOrLoad(
        NS,
        "a",
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          }),
      );
      await cache.delete(NS, "a");

      advance(11 * 60_000);
      vi.advanceTimersByTime(60_000);
      expect(cache.trackedGenerations).toBe(1);

      release("stale");
      await expect(inFlight).resolves.toBe("stale");
      await expect(cache.get(NS, "a")).resolves.toBeUndefined();
      cache.stop();
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
