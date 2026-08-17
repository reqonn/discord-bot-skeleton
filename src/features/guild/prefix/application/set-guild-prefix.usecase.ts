import { ok, type Result } from "#shared/result/result.js";
import type { Snowflake } from "#shared/types/snowflake.types.js";

import { parsePrefix } from "../domain/prefix.rules.js";

import type { GetGuildPrefixUseCase } from "./get-guild-prefix.usecase.js";
import type { GuildPrefixRepository } from "./ports/guild-prefix.repository.js";

/**
 * Changing a guild's prefix.
 *
 * Validate, write, invalidate — in that order. Invalidating *after* the write
 * means a concurrent reader sees either the old value or the new one, never a
 * cache entry repopulated from a row that was about to change.
 *
 * The rule itself is not here. It lives in `domain/`, and this use case only
 * propagates what it decided — which is what keeps the rule testable without a
 * database, and impossible to bypass by adding a second caller.
 */
export class SetGuildPrefixUseCase {
  constructor(
    private readonly repository: GuildPrefixRepository,
    private readonly prefixes: GetGuildPrefixUseCase,
  ) {}

  async set(guildId: Snowflake, raw: string): Promise<Result<string>> {
    const parsed = parsePrefix(raw);
    // The compiler will not let this branch be skipped. That is the entire
    // reason the domain returns Result rather than throwing.
    if (!parsed.ok) return parsed;

    await this.repository.save(guildId, parsed.value);
    await this.prefixes.invalidate(guildId);

    return ok(parsed.value);
  }

  /** Removes the override, so the guild falls back to COMMAND_PREFIX. */
  async clear(guildId: Snowflake): Promise<Result<null>> {
    await this.repository.clear(guildId);
    await this.prefixes.invalidate(guildId);

    return ok(null);
  }
}
