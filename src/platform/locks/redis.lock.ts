import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";

import type { Logger } from "../logging/logger.contract.js";

import type { Lock } from "./lock.contract.js";

/** Renew at a third of the TTL, so two renewals may fail before the lease lapses. */
const RENEW_FRACTION = 3;

/**
 * Extends the lease only if we still hold it.
 *
 * Compare-and-set rather than a bare PEXPIRE: if our lease already lapsed and
 * another instance took the lock, blindly extending would hand us a lock we do
 * not own and let two instances run the same job.
 */
const RENEW_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

/** Deletes only our own lease, for the same reason. */
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/**
 * A Redis lease.
 *
 * `SET NX PX` with a random token, renewed on a timer while the work runs, and
 * released only if the token still matches. If a renewal finds the lease gone —
 * because this process stalled long enough for it to expire — the abort signal
 * fires and the handler is expected to stop. Continuing past that point is the
 * failure this whole mechanism exists to prevent.
 */
export class RedisLock implements Lock {
  private readonly logger: Logger;

  constructor(
    private readonly redis: Redis,
    logger: Logger,
  ) {
    this.logger = logger.child({ subsystem: "lock" });
  }

  async runExclusive<T>(
    name: string,
    ttlMs: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    const key = `lock:${name}`;
    const token = randomUUID();

    const acquired = await this.redis.set(key, token, "PX", ttlMs, "NX");
    if (acquired === null) return undefined;

    const controller = new AbortController();
    const renewal = setInterval(
      () => {
        void this.renew(key, token, ttlMs, name, controller);
      },
      Math.floor(ttlMs / RENEW_FRACTION),
    );

    try {
      return await work(controller.signal);
    } finally {
      clearInterval(renewal);
      try {
        await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
      } catch (error) {
        // The lease expires on its own, so a failed release delays the next
        // run rather than breaking correctness.
        this.logger.warn("Could not release lock", { error, lock: name });
      }
    }
  }

  private async renew(
    key: string,
    token: string,
    ttlMs: number,
    name: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      const extended = await this.redis.eval(RENEW_SCRIPT, 1, key, token, String(ttlMs));
      if (extended === 0) {
        this.logger.warn("Lost lock lease; signalling the holder to stop", { lock: name });
        controller.abort();
      }
    } catch (error) {
      // A Redis blip is not proof the lease is gone. Log and let the next
      // renewal decide; aborting here would stop correct work unnecessarily.
      this.logger.warn("Could not renew lock", { error, lock: name });
    }
  }
}
