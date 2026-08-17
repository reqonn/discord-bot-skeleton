import type { Snowflake } from "#shared/types/snowflake.types.js";

import type { WelcomeSettings } from "../../domain/welcome.rules.js";

/**
 * Storage for a guild's welcome configuration.
 *
 * Two methods, because that is the whole of it. `save` takes the entire
 * settings object rather than a patch: a patch API invites partial writes that
 * race, while replacing the row is one statement with one outcome — the caller
 * reads, applies its change, and writes back.
 */
export interface WelcomeRepository {
  findSettings(guildId: Snowflake): Promise<WelcomeSettings | undefined>;
  saveSettings(settings: WelcomeSettings): Promise<void>;
}
