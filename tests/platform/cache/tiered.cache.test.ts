import { describe, expect, it, vi } from "vitest";

import type { Cache, CacheNamespace } from "#platform/cache/cache.contract.js";
import { MemoryCache } from "#platform/cache/memory.cache.js";
import { TieredCache } from "#platform/cache/tiered.cache.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

const NS: CacheNamespace = {
  name: "test:thing",
  owner: "test",
  ttlMs: 1_000,
  description: "A thing.",
};

/**
 * A stand-in for the shared tier, with a hook for holding a read open.
 *
 * The far tier is a network round trip in production, and the gap it leaves is
 * the whole subject of these tests — so it has to be a gap the test controls
 * rather than one that happens to exist.
 */
function farTier() {
  const values = new Map<string, unknown>();
  let hold: Promise<void> | undefined;

  const cache: Cache = {
    get: async <T>(namespace: CacheNamespace, id: string): Promise<T | undefined> => {
      // The value is read first and the stall applied after, which is what a
      // real round trip does: the answer left the shared tier before the
      // invalidation landed, and arrives here carrying what was true then.
      const value = values.get(`${namespace.name}:${id}`) as T | undefined;
      if (hold !== undefined) await hold;
      return value;
    },
    set: (namespace, id, value) => {
      values.set(`${namespace.name}:${id}`, value);
      return Promise.resolve();
    },
    delete: (namespace, id) => {
      values.delete(`${namespace.name}:${id}`);
      return Promise.resolve();
    },
    clear: (namespace) => {
      for (const key of [...values.keys()]) {
        if (key.startsWith(`${namespace.name}:`)) values.delete(key);
      }
      return Promise.resolve();
    },
    getOrLoad: async <T>(
      namespace: CacheNamespace,
      id: string,
      load: () => Promise<T>,
    ): Promise<T> => {
      const key = `${namespace.name}:${id}`;
      if (values.has(key)) return values.get(key) as T;
      const value = await load();
      values.set(key, value);
      return value;
    },
  };

  return {
    cache,
    values,
    /** Holds every far read until the returned function is called. */
    stall: () => {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        hold = undefined;
        release();
      };
    },
  };
}

function tiered() {
  const near = new MemoryCache(new MetricsRegistry());
  const far = farTier();
  return { cache: new TieredCache(near, far.cache), near, far };
}

describe("TieredCache", () => {
  it("answers from the near tier without asking the far one", async () => {
    const { cache, far } = tiered();
    await cache.set(NS, "a", "value");
    const spy = vi.spyOn(far.cache, "get");

    await expect(cache.get(NS, "a")).resolves.toBe("value");
    expect(spy).not.toHaveBeenCalled();
  });

  it("promotes a far hit so the next read stays local", async () => {
    const { cache, near, far } = tiered();
    await far.cache.set(NS, "a", "shared");

    await expect(cache.get(NS, "a")).resolves.toBe("shared");
    await expect(near.get(NS, "a")).resolves.toBe("shared");
  });

  it("writes and invalidates in both tiers", async () => {
    const { cache, near, far } = tiered();
    await cache.set(NS, "a", "value");

    await cache.delete(NS, "a");

    await expect(near.get(NS, "a")).resolves.toBeUndefined();
    await expect(far.cache.get(NS, "a")).resolves.toBeUndefined();
  });

  describe("invalidation during a far read", () => {
    it("does not promote an answer older than a delete", async () => {
      // The far tier is a round trip, and an invalidation can land while it is
      // answering. Promoting regardless puts back into the near tier exactly
      // what the delete took out of it — and leaves it there for the full TTL,
      // on the one instance that was told to forget it.
      const { cache, near, far } = tiered();
      await far.cache.set(NS, "a", "stale");

      const release = far.stall();
      const reading = cache.get(NS, "a");
      // The near tier is consulted first, so let that settle — otherwise the
      // far read has not started yet and the test proves nothing.
      await new Promise((tick) => setTimeout(tick, 0));

      await cache.delete(NS, "a");
      release();

      await expect(reading).resolves.toBe("stale");
      await expect(near.get(NS, "a")).resolves.toBeUndefined();
    });

    it("does not promote an answer older than a clear", async () => {
      const { cache, near, far } = tiered();
      await far.cache.set(NS, "a", "stale");

      const release = far.stall();
      const reading = cache.get(NS, "a");
      await new Promise((tick) => setTimeout(tick, 0));

      await cache.clear(NS);
      release();

      await expect(reading).resolves.toBe("stale");
      await expect(near.get(NS, "a")).resolves.toBeUndefined();
    });
  });
});
