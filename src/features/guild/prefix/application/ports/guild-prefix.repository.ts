import type { Snowflake } from "#shared/types/snowflake.types.js";

/**
 * Storage for per-guild prefixes.
 *
 * Owned by the application layer, implemented in `infrastructure/`. That
 * direction is the point: the use cases depend on this interface and never on
 * PostgreSQL, so they are tested against an in-memory fake with no database
 * running, and would survive the storage being replaced entirely.
 *
 * Deliberately small — a port describes what this feature needs, not everything
 * a table could support. There is no `findAll` because nothing lists prefixes.
 */
export interface GuildPrefixRepository {
  /** Undefined when the guild has never set one, which means "use the default". */
  find(guildId: Snowflake): Promise<string | undefined>;

  save(guildId: Snowflake, prefix: string): Promise<void>;

  /** Removes the override. Safe to call when there is nothing to remove. */
  clear(guildId: Snowflake): Promise<void>;
}
