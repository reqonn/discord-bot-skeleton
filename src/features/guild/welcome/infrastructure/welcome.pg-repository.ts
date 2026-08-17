import type { Database } from "#platform/database/database.contract.js";

import { asSnowflake, type Snowflake } from "#shared/types/snowflake.types.js";

import type { WelcomeRepository } from "../application/ports/welcome.repository.js";
import type { WelcomeSettings } from "../domain/welcome.rules.js";

/** Rows as PostgreSQL returns them: snake_case, nullable, driver-typed. */
interface SettingsRow {
  readonly guild_id: string;
  readonly channel_id: string | null;
  readonly message: string;
  readonly enabled: boolean;
}

export class PgWelcomeRepository implements WelcomeRepository {
  constructor(private readonly database: Database) {}

  async findSettings(guildId: Snowflake): Promise<WelcomeSettings | undefined> {
    const row = await this.database.queryOne<SettingsRow>(
      `SELECT guild_id, channel_id, message, enabled
         FROM welcome_settings
        WHERE guild_id = $1`,
      [guildId],
    );

    return row === undefined ? undefined : toSettings(row);
  }

  async saveSettings(settings: WelcomeSettings): Promise<void> {
    // One statement rather than a read followed by an insert or update: two
    // guilds configured at the same moment would otherwise race, and the loser
    // fails on the primary key.
    await this.database.execute(
      `INSERT INTO welcome_settings (guild_id, channel_id, message, enabled)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (guild_id) DO UPDATE
               SET channel_id = EXCLUDED.channel_id,
                   message    = EXCLUDED.message,
                   enabled    = EXCLUDED.enabled,
                   updated_at = now()`,
      [settings.guildId, settings.channelId, settings.message, settings.enabled],
    );
  }
}

function toSettings(row: SettingsRow): WelcomeSettings {
  return {
    guildId: asSnowflake(row.guild_id),
    channelId: row.channel_id === null ? null : asSnowflake(row.channel_id),
    message: row.message,
    enabled: row.enabled,
  };
}
