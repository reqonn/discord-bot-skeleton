import type { WelcomeRepository } from "#features/guild/welcome/application/ports/welcome.repository.js";
import type { WelcomeSettings } from "#features/guild/welcome/domain/welcome.rules.js";

import type { Snowflake } from "#shared/types/snowflake.types.js";

/**
 * The welcome repository, in memory.
 *
 * A fake, not a mock. Rows are stored and returned, so a test exercises the
 * real flow — read, change, read back — rather than asserting which method was
 * called. Keyed by guild id exactly as the table is, which is what lets a test
 * model a restart honestly: build a new use case over the same store and the
 * configuration is still there.
 */
export class MemoryWelcomeRepository implements WelcomeRepository {
  readonly settings = new Map<string, WelcomeSettings>();

  findSettings(guildId: Snowflake): Promise<WelcomeSettings | undefined> {
    return Promise.resolve(this.settings.get(guildId));
  }

  saveSettings(settings: WelcomeSettings): Promise<void> {
    this.settings.set(settings.guildId, settings);
    return Promise.resolve();
  }
}
