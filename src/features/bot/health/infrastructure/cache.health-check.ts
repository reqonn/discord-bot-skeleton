import type { Cache, CacheNamespace } from "#platform/cache/cache.contract.js";

import type { CheckOutcome, HealthCheck } from "../application/ports/health-check.port.js";

/**
 * A namespace used only by this check.
 *
 * Declared here rather than in the shared catalog because nothing else reads
 * it — the catalog exists to make the *shared* keyspace enumerable, and a
 * write-then-read probe is not part of it.
 */
const PROBE: CacheNamespace = {
  name: "health:probe",
  owner: "health",
  ttlMs: 5_000,
  description: "Round-trip probe written and read by the health check.",
};

/**
 * Confirms the cache round-trips a value.
 *
 * Writes and reads rather than only reading: a cache that accepts writes and
 * returns nothing is the failure mode that matters, and a read-only probe
 * cannot see it.
 *
 * The `tier` label is what makes development legible — `/ping` reporting
 * "memory" is how you confirm at a glance that you are running without Redis.
 */
export class CacheHealthCheck implements HealthCheck {
  readonly name = "cache";

  constructor(
    private readonly cache: Cache,
    private readonly tier: string,
  ) {}

  async check(): Promise<CheckOutcome> {
    const startedAt = performance.now();
    const token = String(startedAt);

    await this.cache.set(PROBE, "probe", token);
    const readBack = await this.cache.get<string>(PROBE, "probe");

    const healthy = readBack === token;

    return {
      name: this.name,
      healthy,
      latencyMs: Math.round(performance.now() - startedAt),
      detail: healthy ? this.tier : `${this.tier} (write succeeded but read did not return it)`,
    };
  }
}
