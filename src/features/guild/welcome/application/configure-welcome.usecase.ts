import type { Cache, CacheNamespace } from "#platform/cache/cache.contract.js";

import { ok, type Result } from "#shared/result/result.js";
import type { Snowflake } from "#shared/types/snowflake.types.js";

import {
  emptySettings,
  isReady,
  parseWelcomeMessage,
  type WelcomeSettings,
} from "../domain/welcome.rules.js";

import type { WelcomeRepository } from "./ports/welcome.repository.js";

/**
 * The namespace this feature owns.
 *
 * Declared beside the code that reads it rather than in a central catalogue
 * every feature would have to edit — the same reason the domain errors live in
 * the feature. Owner and TTL travel with it, so "what is in the cache, who put
 * it there, and how stale can it be" is answerable from one screen.
 */
const SETTINGS: CacheNamespace = {
  name: "guild:welcome",
  owner: "guild/welcome",
  // Every write invalidates explicitly, so this is only the backstop for the
  // case where *another instance* did the writing.
  ttlMs: 300_000,
  description: "Per-guild welcome message and channel, keyed by guild id.",
};

/**
 * Reading and changing the welcome configuration.
 *
 * The only way this feature writes anything. `/welcome message`, the editor's
 * modal, the channel picker and `/welcome reset` all land here, so a change
 * made through a button and the same change made through a command cannot
 * diverge — including the validation, which runs in the domain either way.
 *
 * Every method returns the settings as they now stand, which is what lets a
 * panel re-render from the return value instead of reading back and hoping it
 * sees its own write.
 *
 * **Reads are cached, and this is a hot path.** `memberJoined` fires for every
 * join in every guild the bot is in, and each one asks this whether a greeting
 * is configured — which for most guilds is a database round trip to be told
 * "no". A raid is that same question a few hundred times a minute. `getOrLoad`
 * also single-flights concurrent misses, so a burst produces one read rather
 * than one per join in flight, and the "nothing configured" answer is cached
 * too, since it is by far the most common one.
 */
export class ConfigureWelcomeUseCase {
  constructor(
    private readonly repository: WelcomeRepository,
    private readonly cache: Cache,
  ) {}

  /** What is configured now. The empty configuration when nothing is. */
  async settings(guildId: Snowflake): Promise<Result<WelcomeSettings>> {
    return ok(await this.current(guildId));
  }

  async setMessage(guildId: Snowflake, raw: string): Promise<Result<WelcomeSettings>> {
    const parsed = parseWelcomeMessage(raw);
    // The compiler will not let this branch be skipped, which is the whole
    // reason the domain returns Result rather than throwing.
    if (!parsed.ok) return parsed;

    return this.apply(guildId, (current) => ({ ...current, message: parsed.value }));
  }

  async setChannel(guildId: Snowflake, channelId: Snowflake): Promise<Result<WelcomeSettings>> {
    return this.apply(guildId, (current) => ({ ...current, channelId }));
  }

  /**
   * Puts the guild back to never-configured.
   *
   * A reset, not a pause: the message and the channel go with it. Anything that
   * left the old text behind would restore it the moment someone set a channel
   * again, which is a surprise nobody asked for.
   */
  async reset(guildId: Snowflake): Promise<Result<WelcomeSettings>> {
    const cleared = emptySettings(guildId);

    await this.store(cleared);
    return ok(cleared);
  }

  private async apply(
    guildId: Snowflake,
    change: (current: WelcomeSettings) => WelcomeSettings,
  ): Promise<Result<WelcomeSettings>> {
    const updated = change(await this.current(guildId));

    // `enabled` is derived by the domain rather than set here, so storage can
    // never hold a guild that claims to be greeting people with no channel to
    // greet them in.
    const settled: WelcomeSettings = { ...updated, enabled: isReady(updated) };

    await this.store(settled);
    return ok(settled);
  }

  private async current(guildId: Snowflake): Promise<WelcomeSettings> {
    return this.cache.getOrLoad(
      SETTINGS,
      guildId,
      async () => (await this.repository.findSettings(guildId)) ?? emptySettings(guildId),
    );
  }

  /**
   * Writes through, rather than dropping the entry.
   *
   * The next read is almost always the panel re-rendering the change that was
   * just made, so replacing the entry saves that read entirely — and unlike a
   * delete it cannot leave a window where a concurrent join repopulates the
   * cache from a stale row.
   */
  private async store(settings: WelcomeSettings): Promise<void> {
    await this.repository.saveSettings(settings);
    await this.cache.set(SETTINGS, settings.guildId, settings);
  }
}
