import type { Cache, CacheNamespace } from "#platform/cache/cache.contract.js";

import { ok, type Result } from "#shared/result/result.js";
import type { Snowflake } from "#shared/types/snowflake.types.js";

import type { GuildPrefixRepository } from "./ports/guild-prefix.repository.js";

/**
 * The namespace this feature owns.
 *
 * Declared beside the code that reads it rather than in a central catalogue
 * every feature would have to edit — the same reason the domain errors live in
 * the feature. Owner and TTL travel with it, so "what is in the cache, who put
 * it there, and how stale can it be" is answerable from one screen.
 */
const PREFIXES: CacheNamespace = {
  name: "guild:prefix",
  owner: "guild/prefix",
  // A write invalidates explicitly, so this is only the backstop for the case
  // where *another instance* did the writing. Short enough that the wrong
  // prefix is never wrong for long.
  ttlMs: 60_000,
  description: "Per-guild command prefix override, keyed by guild id.",
};

/**
 * A guild's prefix, or nothing if it uses the default.
 *
 * This is the hot path. The message pipeline calls it for every message in
 * every guild, before it can know whether the message is even a command — so
 * the cache is not an optimisation here, it is the reason this is affordable
 * at all.
 *
 * `getOrLoad` single-flights concurrent misses: a busy guild whose entry has
 * just expired produces one database read, not one per message in flight. The
 * "no override" answer is cached too, since most guilds never set one and that
 * would otherwise be the single case that always hits the database.
 */
export class GetGuildPrefixUseCase {
  constructor(
    private readonly repository: GuildPrefixRepository,
    private readonly cache: Cache,
  ) {}

  async execute(guildId: Snowflake): Promise<Result<string | null>> {
    const prefix = await this.cache.getOrLoad(PREFIXES, guildId, async () => {
      // Null rather than undefined: a cache stores "I looked and there was
      // nothing" only if that value can be represented.
      const stored = await this.repository.find(guildId);
      return stored ?? null;
    });

    return ok(prefix);
  }

  /** Drops the cached entry. Called by the write path, which owns correctness. */
  async invalidate(guildId: Snowflake): Promise<void> {
    await this.cache.delete(PREFIXES, guildId);
  }
}
