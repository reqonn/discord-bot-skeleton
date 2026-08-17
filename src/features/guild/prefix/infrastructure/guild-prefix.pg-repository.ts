import type { Database } from "#platform/database/database.contract.js";

import type { Snowflake } from "#shared/types/snowflake.types.js";

import type { GuildPrefixRepository } from "../application/ports/guild-prefix.repository.js";

/**
 * The prefix port, over PostgreSQL.
 *
 * Raw parameterized SQL, no ORM. The repository interface already gives the
 * swappability an ORM is usually adopted for, and being able to read the exact
 * statement — and the index it uses — is worth more than a query builder here
 * (ADR-0004). Every value is a parameter; string-built SQL is not acceptable.
 */

/** The row as PostgreSQL returns it: snake_case, all text. */
interface PrefixRow {
  readonly prefix: string;
}

export class PgGuildPrefixRepository implements GuildPrefixRepository {
  constructor(private readonly database: Database) {}

  async find(guildId: Snowflake): Promise<string | undefined> {
    const row = await this.database.queryOne<PrefixRow>(
      `SELECT prefix FROM guild_prefixes WHERE guild_id = $1`,
      [guildId],
    );

    return row?.prefix;
  }

  async save(guildId: Snowflake, prefix: string): Promise<void> {
    // Upsert rather than select-then-insert-or-update. One statement is one
    // round trip, and more importantly it is atomic: the two-statement version
    // has a window in which a concurrent insert makes the insert fail — a bug
    // that only ever shows up under load.
    await this.database.execute(
      `INSERT INTO guild_prefixes (guild_id, prefix)
            VALUES ($1, $2)
       ON CONFLICT (guild_id) DO UPDATE
               SET prefix     = EXCLUDED.prefix,
                   updated_at = now()`,
      [guildId, prefix],
    );
  }

  async clear(guildId: Snowflake): Promise<void> {
    // Deleting the row is how "use the default" is stored. Keeping a row with
    // a null prefix would create a second way to say the same thing, and two
    // representations of one state eventually disagree.
    await this.database.execute(`DELETE FROM guild_prefixes WHERE guild_id = $1`, [guildId]);
  }
}
