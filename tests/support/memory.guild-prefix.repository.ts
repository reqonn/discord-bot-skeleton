import type { GuildPrefixRepository } from "#features/guild/prefix/application/ports/guild-prefix.repository.js";

import type { Snowflake } from "#shared/types/snowflake.types.js";

/**
 * The prefix repository, in memory.
 *
 * A fake, not a mock: it stores what you save and returns what you stored, so
 * a test asserts on behaviour rather than on which method was called with
 * which arguments. When the port changes, this fails to compile — feedback a
 * mock would have swallowed.
 *
 * This is the payoff of the port. Every use case test below runs with no
 * database, no container and no migration, in microseconds — and the same
 * tests would pass unchanged if the storage were replaced tomorrow.
 *
 * `reads` is exposed because caching is the thing under test: proving a cache
 * works means proving the database was *not* consulted.
 */
export class MemoryGuildPrefixRepository implements GuildPrefixRepository {
  private readonly prefixes = new Map<string, string>();
  /** How many times storage was actually consulted. */
  reads = 0;

  constructor(seed: Readonly<Record<string, string>> = {}) {
    for (const [guildId, prefix] of Object.entries(seed)) this.prefixes.set(guildId, prefix);
  }

  find(guildId: Snowflake): Promise<string | undefined> {
    this.reads += 1;
    return Promise.resolve(this.prefixes.get(guildId));
  }

  save(guildId: Snowflake, prefix: string): Promise<void> {
    this.prefixes.set(guildId, prefix);
    return Promise.resolve();
  }

  clear(guildId: Snowflake): Promise<void> {
    this.prefixes.delete(guildId);
    return Promise.resolve();
  }
}
