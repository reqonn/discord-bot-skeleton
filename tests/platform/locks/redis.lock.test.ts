import type { Redis } from "ioredis";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RedisLock } from "#platform/locks/redis.lock.js";

import { MemoryLogger } from "#testing/memory.logger.js";

/**
 * Just enough of ioredis to drive the lease.
 *
 * A real Redis is exercised by tests/integration/redis.test.ts, which skips
 * when none is running. The behaviour here — what happens when Redis is
 * unreachable, and how often the renewal timer fires — has to be asserted
 * whether or not a server is available, because both are about the cases a
 * healthy server never produces.
 */
function fakeRedis(overrides: Partial<Redis> = {}): Redis {
  return {
    set: vi.fn().mockResolvedValue("OK"),
    eval: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as Redis;
}

const timers: NodeJS.Timeout[] = [];
const realSetInterval = globalThis.setInterval;

/** Captures every interval the lock arms, so the test can inspect it. */
function captureIntervals(): void {
  vi.spyOn(globalThis, "setInterval").mockImplementation((handler: () => void, ms?: number) => {
    const timer = realSetInterval(handler, ms);
    timers.push(timer);
    return timer;
  });
}

afterEach(() => {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  vi.restoreAllMocks();
});

describe("RedisLock", () => {
  it("runs the work when the lease is granted", async () => {
    const lock = new RedisLock(fakeRedis(), new MemoryLogger());

    await expect(lock.runExclusive("job", 30_000, () => Promise.resolve("done"))).resolves.toBe(
      "done",
    );
  });

  it("does not run the work when somebody else holds the lease", async () => {
    const lock = new RedisLock(
      fakeRedis({ set: vi.fn().mockResolvedValue(null) }),
      new MemoryLogger(),
    );
    const work = vi.fn().mockResolvedValue("done");

    await expect(lock.runExclusive("job", 30_000, work)).resolves.toBeUndefined();
    expect(work).not.toHaveBeenCalled();
  });

  it("refuses the lease when Redis cannot be reached, rather than throwing", async () => {
    // Fail closed, and fail quietly. An unreachable Redis is not a bug in the
    // job, so it must not surface as one — and it must never be read as
    // "nobody holds it", which would let every instance run a singleton at
    // once. Throwing here recorded the job as failed, which sends whoever is
    // on call looking at the wrong thing.
    const lock = new RedisLock(
      fakeRedis({ set: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) }),
      new MemoryLogger(),
    );
    const work = vi.fn().mockResolvedValue("done");

    await expect(lock.runExclusive("job", 30_000, work)).resolves.toBeUndefined();
    expect(work).not.toHaveBeenCalled();
  });

  it("does not hold the process open while the work runs", async () => {
    // A lease renewal is never a reason to keep a shutting-down bot alive. The
    // timer lives as long as the work does, so without unref a job that hangs
    // keeps the event loop busy and the process never exits.
    captureIntervals();
    const lock = new RedisLock(fakeRedis(), new MemoryLogger());

    await lock.runExclusive("job", 30_000, () => {
      expect(timers).toHaveLength(1);
      expect(timers[0]?.hasRef()).toBe(false);
      return Promise.resolve();
    });
  });

  it("does not renew faster than once a second, however short the lease", async () => {
    // `ttlMs / 3` floors to 0 for a short lease, and setInterval treats 0 as
    // "every tick" — which turns a lock into a tight loop against Redis.
    captureIntervals();
    const lock = new RedisLock(fakeRedis(), new MemoryLogger());
    const seen: number[] = [];
    vi.spyOn(globalThis, "setInterval").mockImplementation((handler: () => void, ms?: number) => {
      seen.push(ms ?? 0);
      const timer = realSetInterval(handler, ms);
      timers.push(timer);
      return timer;
    });

    await lock.runExclusive("job", 100, () => Promise.resolve());

    expect(seen[0]).toBeGreaterThanOrEqual(1_000);
  });
});
