import { defineFeature, type Feature } from "#app/feature.contract.js";

import type { Cache } from "#platform/cache/cache.contract.js";
import type { Database } from "#platform/database/database.contract.js";

import { createPrefixCommand } from "./api/prefix.command.js";
import { GetGuildPrefixUseCase } from "./application/get-guild-prefix.usecase.js";
import { SetGuildPrefixUseCase } from "./application/set-guild-prefix.usecase.js";
import { PgGuildPrefixRepository } from "./infrastructure/guild-prefix.pg-repository.js";

export interface PrefixDeps {
  readonly database: Database;
  readonly cache: Cache;
  /** The configured fallback, shown when a guild has set none. */
  readonly defaultPrefix: string;
}

/**
 * Per-guild command prefix — the reference for a feature that stores something.
 *
 * `bot/health` shows a feature with no state. This one shows the rest, and is
 * the directory to copy when you need to persist anything:
 *
 *   domain/          the rule, pure — tested by calling it with strings
 *   application/     use cases returning Result, depending on a port
 *   ports/           the interface the use cases need
 *   infrastructure/  that interface over PostgreSQL, with real SQL
 *   api/             the Discord adapter, importing neither of the above two
 *   database/migrations/0001_create-guild-prefixes.up.sql
 *
 * Note what the manifest reveals: `PrefixDeps` lists exactly what the feature
 * needs, so its dependencies are readable without opening a file inside it.
 * Everything else is constructed here and never escapes — nothing outside this
 * directory can reach the repository.
 *
 * **Deleting it is one directory, one line in `src/app/features.ts`, one line
 * in `src/app/bootstrap.ts`, and the migration.** Nothing else refers to it.
 */
export function createPrefixFeature(deps: PrefixDeps): Feature {
  const prefixes = new GetGuildPrefixUseCase(
    new PgGuildPrefixRepository(deps.database),
    deps.cache,
  );
  const update = new SetGuildPrefixUseCase(new PgGuildPrefixRepository(deps.database), prefixes);

  return defineFeature({
    id: "prefix",
    commands: [createPrefixCommand(prefixes, update, deps.defaultPrefix)],
  });
}

/**
 * The read path alone, for the message pipeline.
 *
 * The pipeline needs a guild's prefix on every message but must not import a
 * feature — `discord-kernel-is-feature-agnostic` forbids it, and rightly: the
 * kernel would then depend on something a project may delete. So the
 * composition root builds this function and hands it over, and all the kernel
 * ever sees is "something that resolves a prefix".
 */
export function createGuildPrefixResolver(
  deps: Omit<PrefixDeps, "defaultPrefix">,
): (guildId: string) => Promise<string | undefined> {
  const prefixes = new GetGuildPrefixUseCase(
    new PgGuildPrefixRepository(deps.database),
    deps.cache,
  );

  return async (guildId) => {
    const result = await prefixes.execute(asGuildId(guildId));
    return result.ok ? (result.value ?? undefined) : undefined;
  };
}

/** The pipeline deals in raw ids; the feature deals in branded ones. */
function asGuildId(guildId: string): Parameters<GetGuildPrefixUseCase["execute"]>[0] {
  return guildId as Parameters<GetGuildPrefixUseCase["execute"]>[0];
}
