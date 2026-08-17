import { afterEach, describe, expect, it } from "vitest";

import { buildInfrastructure, type Infrastructure } from "#app/wiring.js";

import { loadConfig } from "#platform/config/config.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import { MemoryLogger } from "#testing/memory.logger.js";

/**
 * The composition root, actually composed.
 *
 * `buildInfrastructure` is the single file that decides which implementation of
 * every port a deployment gets, and it had no test — meaning the production
 * branch, which wires TieredCache and RedisLock, had never been constructed
 * outside a live deploy. The Redis classes themselves are covered in
 * tests/integration/redis.test.ts; what was missing is proof that the wiring
 * reaches them at all.
 *
 * The Redis half is skipped when REDIS_URL is unset, exactly as that suite is,
 * so `pnpm verify` still passes on a machine with no Redis. CI sets it.
 */

const BASE = {
  DISCORD_TOKEN: "token",
  DISCORD_CLIENT_ID: "1",
  // A pool is lazy: nothing connects until a query runs, and none is run here.
  DATABASE_URL: "postgres://bot:bot@127.0.0.1:55432/bot",
};

const raw = process.env["REDIS_URL"];
const REDIS_URL = raw === undefined || raw === "" ? undefined : raw;

let built: Infrastructure | undefined;

afterEach(async () => {
  await built?.stop();
  built = undefined;
});

function build(env: Record<string, string | undefined>): Infrastructure {
  built = buildInfrastructure(
    loadConfig({ ...BASE, ...env }),
    new MemoryLogger(),
    new MetricsRegistry(),
  );
  return built;
}

describe("buildInfrastructure", () => {
  describe("without Redis", () => {
    it("wires the in-process cache and reports the tier", () => {
      const infrastructure = build({});

      // /ping surfaces this, so the running mode is visible rather than guessed.
      expect(infrastructure.cacheTier).toBe("memory");
      expect(infrastructure.redis).toBeUndefined();
    });

    it("produces a working cache and lock", async () => {
      const infrastructure = build({});
      await infrastructure.start();
      const namespace = {
        name: "wiring:test",
        owner: "test",
        ttlMs: 1_000,
        description: "Fixture.",
      };

      await infrastructure.cache.set(namespace, "a", 1);

      await expect(infrastructure.cache.get(namespace, "a")).resolves.toBe(1);
      await expect(
        infrastructure.lock.runExclusive("wiring", 1_000, () => Promise.resolve("ran")),
      ).resolves.toBe("ran");
    });

    it("says what is degraded rather than leaving it to be discovered", () => {
      const logger = new MemoryLogger();
      built = buildInfrastructure(loadConfig({ ...BASE }), logger, new MetricsRegistry());

      expect(logger.messages("warn").join(" ")).toContain("without Redis");
    });

    it("warns differently in production, where the constraint has teeth", () => {
      // Permitted — a single-instance bot does not need Redis — but the moment
      // someone raises the replica count it is wrong, and nothing else will say
      // so at that point.
      const logger = new MemoryLogger();
      built = buildInfrastructure(
        loadConfig({ ...BASE, NODE_ENV: "production" }),
        logger,
        new MetricsRegistry(),
      );

      expect(logger.messages("warn").join(" ")).toContain("MUST STAY SINGLE");
    });

    it("stops cleanly, twice, so a failed boot can tear down safely", async () => {
      const infrastructure = build({});

      await infrastructure.stop();
      // bootstrap.ts runs the shutdown sequence after a failed start, which can
      // reach a component that already stopped.
      await expect(infrastructure.stop()).resolves.not.toThrow();
      built = undefined;
    });
  });

  describe.skipIf(REDIS_URL === undefined)("with Redis", () => {
    it("wires the tiered cache and reports the tier", () => {
      const infrastructure = build({ REDIS_URL });

      expect(infrastructure.cacheTier).toBe("tiered");
      expect(infrastructure.redis).toBeDefined();
    });

    it("connects on start, so the first cache write is not the one that fails", async () => {
      // The bug this caught. The client is built lazyConnect with the offline
      // queue disabled, so a command issued before the socket is up fails
      // rather than waiting — which made the first cache write of every deploy
      // the casualty. start() is what makes "fail fast" mean "fail when Redis
      // is actually down".
      const infrastructure = build({ REDIS_URL });

      await infrastructure.start();

      expect(infrastructure.redis?.status).toBe("ready");
    });

    it("produces a cache that round-trips through Redis", async () => {
      const infrastructure = build({ REDIS_URL });
      await infrastructure.start();
      const namespace = {
        name: "wiring:tiered",
        owner: "test",
        ttlMs: 2_000,
        description: "Fixture.",
      };

      await infrastructure.cache.set(namespace, "key", { ok: true });

      await expect(infrastructure.cache.get(namespace, "key")).resolves.toEqual({ ok: true });
      // Written through to L2, not only held in the local tier.
      await expect(infrastructure.redis?.exists("wiring:tiered:key")).resolves.toBe(1);
    });

    it("produces a lock that holds across callers", async () => {
      const infrastructure = build({ REDIS_URL });
      await infrastructure.start();

      await expect(
        infrastructure.lock.runExclusive("wiring:redis", 2_000, () => Promise.resolve("ran")),
      ).resolves.toBe("ran");
    });

    it("does not warn about degradation", () => {
      const logger = new MemoryLogger();
      built = buildInfrastructure(
        loadConfig({ ...BASE, REDIS_URL }),
        logger,
        new MetricsRegistry(),
      );

      expect(logger.messages("warn").join(" ")).not.toContain("without Redis");
    });
  });
});
