import { Redis } from "ioredis";

import type { Cache } from "#platform/cache/cache.contract.js";
import { MemoryCache } from "#platform/cache/memory.cache.js";
import { RedisCache } from "#platform/cache/redis.cache.js";
import { TieredCache } from "#platform/cache/tiered.cache.js";
import type { Config } from "#platform/config/config.js";
import { PgDatabase } from "#platform/database/pg.database.js";
import { LocalLock } from "#platform/locks/local.lock.js";
import type { Lock } from "#platform/locks/lock.contract.js";
import { RedisLock } from "#platform/locks/redis.lock.js";
import type { Logger } from "#platform/logging/logger.contract.js";
import type { Metrics } from "#platform/metrics/metrics.contract.js";
import type { CooldownStore } from "#platform/ratelimit/cooldown.contract.js";
import { MemoryCooldownStore } from "#platform/ratelimit/memory.cooldown.js";

export interface Infrastructure {
  readonly database: PgDatabase;
  readonly cache: Cache;
  /** Which cache implementation is live. Surfaced by /ping. */
  readonly cacheTier: "memory" | "tiered";
  readonly lock: Lock;
  readonly cooldowns: CooldownStore;
  readonly redis: Redis | undefined;

  /**
   * Opens connections that must be live before traffic arrives.
   *
   * Separate from construction because it is async, and construction is not.
   * Load-bearing for Redis: the client is built `lazyConnect` with the offline
   * queue *disabled*, so a command issued before the socket is up does not wait
   * — it fails. Without an explicit connect here, the first cache write of
   * every deploy is that command.
   */
  start(): Promise<void>;

  stop(): Promise<void>;
}

/**
 * The only file that reads the runtime profile to choose an implementation.
 *
 * This is what "development mode" actually is. There is no `if (isDev)` in any
 * feature, service, or handler — the difference between running with Redis and
 * running without it is which class gets constructed here, twelve lines apart.
 *
 * The consequence worth stating: development exercises the same code paths
 * production runs. A bug in a use case cannot hide behind an environment check,
 * because there is no environment check for it to hide behind. Grep for
 * `redis.enabled` outside this file and platform/config and you will find
 * nothing — tests/architecture/boundaries.test.ts keeps it that way.
 */
export function buildInfrastructure(
  config: Config,
  logger: Logger,
  metrics: Metrics,
): Infrastructure {
  const database = new PgDatabase(config, logger, metrics);
  const memory = new MemoryCache(metrics);
  memory.start();

  const cooldowns = new MemoryCooldownStore();
  cooldowns.start();

  if (!config.redis.enabled) {
    // Development runs without Redis on purpose, and production is allowed to:
    // a single-instance bot genuinely does not need it, and refusing to boot
    // would make the simplest useful deployment the one this rejects.
    //
    // What it cannot do is stay quiet about it. The code that makes the choice
    // is the code that explains what it costs — nobody should have to discover
    // these from behaviour. In production the cost has teeth: every one of
    // these breaks the moment a second replica starts, and the platform that
    // starts it will not ask first.
    const consequences = {
      caching: "in-process only, lost on restart",
      locking: "process-local, unsafe with more than one instance",
      cooldowns: "reset on restart",
    };

    if (config.env === "production") {
      logger.warn("Running in production without Redis — THIS INSTANCE MUST STAY SINGLE", {
        ...consequences,
        scaling: "set REDIS_URL before running more than one replica",
      });
    } else {
      logger.warn("Running without Redis — degraded mode", consequences);
    }

    return {
      database,
      cache: memory,
      cacheTier: "memory",
      lock: new LocalLock(),
      // Cooldowns stay in memory: they are per-user friction, and resetting
      // them on restart is acceptable where sharing them is not yet needed.
      cooldowns,
      redis: undefined,
      start: () => Promise.resolve(),
      stop: async () => {
        memory.stop();
        cooldowns.stop();
        await database.close();
      },
    };
  }

  const redis = new Redis(config.redis.url ?? "", {
    // A hot path must fail fast rather than queue: a cache read that waits for
    // a reconnect is worse than a cache miss.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: true,
    // Reconnect indefinitely, so a failover or a deploy blip heals itself.
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    reconnectOnError: (error) => error.message.includes("READONLY"),
  });

  redis.on("error", (error: unknown) => {
    // Logged, not fatal: every cache operation already degrades to a miss.
    logger.warn("Redis error", { error });
  });

  return {
    database,
    cache: new TieredCache(memory, new RedisCache(redis, metrics, logger)),
    cacheTier: "tiered",
    lock: new RedisLock(redis, logger),
    cooldowns,
    redis,
    start: async () => {
      // `status` guards a double connect, which ioredis rejects. Reachable if a
      // caller retries a failed boot rather than building fresh.
      if (redis.status === "connecting" || redis.status === "connect") return;
      if (redis.status === "ready") return;
      await redis.connect();
    },
    stop: async () => {
      memory.stop();
      cooldowns.stop();
      redis.disconnect();
      await database.close();
    },
  };
}
