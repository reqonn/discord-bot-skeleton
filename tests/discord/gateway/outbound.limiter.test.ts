import { afterEach, describe, expect, it, vi } from "vitest";

import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import { ActionPriority, type LimiterSettings } from "#discord/gateway/action.types.js";
import { OutboundLimiter, type ActionRequest } from "#discord/gateway/outbound.limiter.js";

import { MemoryLogger } from "#testing/memory.logger.js";

let active: OutboundLimiter | undefined;

afterEach(() => {
  active?.stop();
  active = undefined;
});

function limiter(settings: Partial<LimiterSettings> = {}) {
  const metrics = new MetricsRegistry();
  const logger = new MemoryLogger();
  const instance = new OutboundLimiter(logger, metrics, settings);
  active = instance;
  return { limiter: instance, metrics, logger };
}

function action<T>(
  execute: () => Promise<T>,
  overrides: Partial<ActionRequest<T>> = {},
): ActionRequest<T> {
  return {
    guildId: "guild-1",
    feature: "tickets",
    priority: ActionPriority.Normal,
    execute,
    ...overrides,
  };
}

/** A promise you resolve by hand, for controlling in-flight work. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("OutboundLimiter", () => {
  describe("normal operation", () => {
    it("runs an action and returns its value", async () => {
      const { limiter: l } = limiter();

      const result = await l.run(action(() => Promise.resolve("sent")));

      expect(result).toEqual({ ok: true, value: "sent" });
    });

    it("returns a failure rather than throwing", async () => {
      const { limiter: l } = limiter();

      const result = await l.run(action(() => Promise.reject(new Error("boom"))));

      // A Result, not a thrown error and not null: the caller has to decide.
      expect(result.ok).toBe(false);
    });

    it("counts outcomes as metrics", async () => {
      const { limiter: l, metrics } = limiter();
      await l.run(action(() => Promise.resolve(1)));

      expect(metrics.render()).toContain('feature="tickets",outcome="executed"');
    });
  });

  describe("per-guild budget", () => {
    it("queues once the budget is spent, and releases as the window rolls", async () => {
      const { limiter: l } = limiter({
        budgetMaxActions: 2,
        budgetWindowMs: 40,
        drainIntervalMs: 5,
      });
      l.start();

      await l.run(action(() => Promise.resolve(1)));
      await l.run(action(() => Promise.resolve(2)));

      const third = l.run(action(() => Promise.resolve(3)));
      expect(l.stats().queueDepth).toBe(1);

      // Nothing is in flight, so no completion can trigger a drain — only the
      // safety-net tick can, once the rolling window frees capacity. That is
      // precisely the case the tick exists for.
      await expect(third).resolves.toEqual({ ok: true, value: 3 });
      expect(l.stats().queueDepth).toBe(0);
    });

    it("holds a queued action while the budget is genuinely still full", async () => {
      const { limiter: l } = limiter({
        budgetMaxActions: 1,
        budgetWindowMs: 60_000,
        drainIntervalMs: 5,
      });
      l.start();
      await l.run(action(() => Promise.resolve(1)));

      const queued = l.run(action(() => Promise.resolve(2)));
      await new Promise((tick) => setTimeout(tick, 30));

      // Draining must depend on real capacity, not on the tick firing.
      expect(l.stats().queueDepth).toBe(1);
      l.stop();
      active = undefined;
      await expect(queued).resolves.toMatchObject({ ok: false });
    });

    it("does not let one guild's budget affect another", async () => {
      const { limiter: l } = limiter({ budgetMaxActions: 1 });

      await l.run(action(() => Promise.resolve(1), { guildId: "busy" }));
      const quiet = await l.run(action(() => Promise.resolve(2), { guildId: "quiet" }));

      // The failure this prevents: a raid in one server degrading every other.
      expect(quiet).toEqual({ ok: true, value: 2 });
    });

    it("lets critical work bypass the queue entirely", async () => {
      const { limiter: l } = limiter({ budgetMaxActions: 1 });
      await l.run(action(() => Promise.resolve(1)));

      const critical = await l.run(
        action(() => Promise.resolve("moderation"), { priority: ActionPriority.Critical }),
      );

      expect(critical).toEqual({ ok: true, value: "moderation" });
      expect(l.stats().queueDepth).toBe(0);
    });
  });

  describe("process-wide ceiling", () => {
    it("queues once the global budget is spent, however many guilds are involved", async () => {
      // Per-guild budgets stop one server starving the others. They say nothing
      // about the total — and it is the total Discord counts.
      const { limiter: l } = limiter({
        globalMaxActions: 2,
        globalWindowMs: 60_000,
        budgetMaxActions: 100,
        drainIntervalMs: 5,
      });
      l.start();

      await l.run(action(() => Promise.resolve(1), { guildId: "a" }));
      await l.run(action(() => Promise.resolve(2), { guildId: "b" }));

      const third = l.run(action(() => Promise.resolve(3), { guildId: "c" }));
      await new Promise((tick) => setTimeout(tick, 30));

      // A third, otherwise-idle guild is held back, because the process as a
      // whole has spent its allowance.
      expect(l.stats().queueDepth).toBe(1);
      expect(l.stats().globalUsage).toBe(2);

      l.stop();
      active = undefined;
      await expect(third).resolves.toMatchObject({ ok: false });
    });

    it("releases as the global window rolls", async () => {
      const { limiter: l } = limiter({
        globalMaxActions: 1,
        globalWindowMs: 40,
        budgetMaxActions: 100,
        drainIntervalMs: 5,
      });
      l.start();
      await l.run(action(() => Promise.resolve(1), { guildId: "a" }));

      await expect(l.run(action(() => Promise.resolve(2), { guildId: "b" }))).resolves.toEqual({
        ok: true,
        value: 2,
      });
    });

    it("still lets critical work through, and still counts it", async () => {
      const { limiter: l } = limiter({ globalMaxActions: 1, globalWindowMs: 60_000 });
      await l.run(action(() => Promise.resolve(1), { guildId: "a" }));

      const critical = await l.run(
        action(() => Promise.resolve("moderation"), {
          guildId: "b",
          priority: ActionPriority.Critical,
        }),
      );

      expect(critical).toEqual({ ok: true, value: "moderation" });
      // Counted, so the ceiling reflects what was actually sent rather than
      // only what waited for permission.
      expect(l.stats().globalUsage).toBe(2);
    });
  });

  describe("fairness", () => {
    it("does not let the first guild starve the rest under a saturated ceiling", async () => {
      const { limiter: l } = limiter({
        globalMaxActions: 1,
        globalWindowMs: 30,
        budgetMaxActions: 100,
        drainIntervalMs: 5,
        queueTimeoutMs: 5_000,
      });
      l.start();

      // Three guilds queue at once against a ceiling that admits one at a time.
      const served: string[] = [];
      const pending = ["a", "b", "c"].map((guild) =>
        l.run(
          action(
            () => {
              served.push(guild);
              return Promise.resolve(guild);
            },
            { guildId: guild },
          ),
        ),
      );

      await Promise.all(pending);

      // Insertion-order draining would serve "a" every tick. Every guild is
      // served exactly once.
      expect([...served].sort()).toEqual(["a", "b", "c"]);
    });
  });

  describe("concurrency", () => {
    it("holds actions past the concurrency cap", async () => {
      const { limiter: l } = limiter({ concurrencyPerGuild: 1, budgetMaxActions: 100 });
      const first = deferred<string>();

      const running = l.run(action(() => first.promise));
      const waiting = l.run(action(() => Promise.resolve("second")));

      await vi.waitFor(() => {
        expect(l.stats().inFlight).toBe(1);
      });
      expect(l.stats().queueDepth).toBe(1);

      first.resolve("first");
      await expect(running).resolves.toEqual({ ok: true, value: "first" });
      await expect(waiting).resolves.toEqual({ ok: true, value: "second" });
    });
  });

  describe("overflow", () => {
    it("drops when the queue is full and nothing is less urgent", async () => {
      const { limiter: l } = limiter({ concurrencyPerGuild: 1, queueMaxPerGuild: 1 });
      const blocker = deferred<string>();

      const running = l.run(action(() => blocker.promise));
      const queued = l.run(action(() => Promise.resolve("queued")));
      const dropped = await l.run(action(() => Promise.resolve("dropped")));

      expect(dropped.ok).toBe(false);

      blocker.resolve("done");
      await running;
      await queued;
    });

    it("evicts a lower-priority waiter to admit a more urgent one", async () => {
      const { limiter: l } = limiter({ concurrencyPerGuild: 1, queueMaxPerGuild: 1 });
      const blocker = deferred<string>();

      const running = l.run(action(() => blocker.promise));
      const low = l.run(action(() => Promise.resolve("low"), { priority: ActionPriority.Low }));
      const high = l.run(action(() => Promise.resolve("high"), { priority: ActionPriority.High }));

      // A raid flooding the bot with cosmetic work must not delay the
      // moderation action taken in response to it.
      await expect(low).resolves.toMatchObject({ ok: false });

      blocker.resolve("done");
      await running;
      await expect(high).resolves.toEqual({ ok: true, value: "high" });
    });
  });

  describe("queue timeout", () => {
    it("abandons an action that waited too long", async () => {
      const { limiter: l } = limiter({
        concurrencyPerGuild: 1,
        queueTimeoutMs: 10,
        drainIntervalMs: 5,
      });
      l.start();
      const blocker = deferred<string>();

      const running = l.run(action(() => blocker.promise));
      const stale = l.run(action(() => Promise.resolve("never runs")));

      await expect(stale).resolves.toMatchObject({ ok: false });

      blocker.resolve("done");
      await running;
    });
  });

  describe("circuit breaker", () => {
    it("stops calling after repeated failures", async () => {
      const { limiter: l } = limiter({ circuitFailureThreshold: 2 });
      const execute = vi.fn().mockRejectedValue(new Error("discord is down"));

      await l.run(action(execute));
      await l.run(action(execute));
      const refused = await l.run(action(execute));

      expect(refused.ok).toBe(false);
      // The third call never reached Discord — that is the point.
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("keeps other features working", async () => {
      const { limiter: l } = limiter({ circuitFailureThreshold: 1 });
      await l.run(action(() => Promise.reject(new Error("down"))));

      const other = await l.run(action(() => Promise.resolve("fine"), { feature: "welcome" }));

      expect(other).toEqual({ ok: true, value: "fine" });
    });

    it("still runs critical work while the circuit is open", async () => {
      const { limiter: l } = limiter({ circuitFailureThreshold: 1 });
      await l.run(action(() => Promise.reject(new Error("down"))));

      const critical = await l.run(
        action(() => Promise.resolve("moderation"), { priority: ActionPriority.Critical }),
      );

      expect(critical).toEqual({ ok: true, value: "moderation" });
    });

    it("reports open circuits for the gauge", async () => {
      const { limiter: l } = limiter({ circuitFailureThreshold: 1 });
      await l.run(action(() => Promise.reject(new Error("down"))));

      expect(l.stats().openCircuits).toBe(1);
    });
  });

  it("releases queued callers on stop rather than leaving them hanging", async () => {
    const { limiter: l } = limiter({ concurrencyPerGuild: 1 });
    const blocker = deferred<string>();

    const running = l.run(action(() => blocker.promise));
    const queued = l.run(action(() => Promise.resolve("queued")));

    l.stop();
    active = undefined;

    await expect(queued).resolves.toMatchObject({ ok: false });
    blocker.resolve("done");
    await running;
  });
});
