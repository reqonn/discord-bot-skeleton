import { defineFeature, type Feature } from "#app/feature.contract.js";

import type { Cache } from "#platform/cache/cache.contract.js";
import type { Database } from "#platform/database/database.contract.js";
import type { Logger } from "#platform/logging/logger.contract.js";

import type { Messenger } from "#discord/contracts/messenger.contract.js";

import { createMemberJoinedEvent } from "./api/member-joined.event.js";
import { createWelcomeCommands } from "./api/welcome.command.js";
import { createWelcomeComponents } from "./api/welcome.component.js";
import { createWelcomeModals } from "./api/welcome.modal.js";
import { ComposeGreetingUseCase } from "./application/compose-greeting.usecase.js";
import { ConfigureWelcomeUseCase } from "./application/configure-welcome.usecase.js";
import { PgWelcomeRepository } from "./infrastructure/welcome.pg-repository.js";

export interface WelcomeDeps {
  readonly database: Database;
  readonly cache: Cache;
  readonly logger: Logger;
  /** How the bot speaks without being asked. See messenger.contract.ts. */
  readonly messenger: Messenger;
}

/**
 * Greeting new members — the reference for a feature with a full surface.
 *
 * `bot/health` shows a feature with no state and `guild/prefix` one that stores
 * a value. This is everything else, and the directory to copy for anything
 * substantial:
 *
 *   commands     six subcommands, each three lines
 *   components   the editor panel's buttons and its channel picker
 *   modals       the form a button opens
 *   an event     `memberJoined`, which is what makes it actually greet anyone
 *   one port      storage
 *
 * Three things are worth reading for themselves.
 *
 * **`/welcome test` runs the real path.** It calls the same use case the join
 * event does, so a preview cannot be right about a channel the greeting would
 * fail on.
 *
 * **The panel holds no state.** Its custom ids carry no payload; every click
 * reads the settings and writes them back. That is why it survives a deploy,
 * and why there is no session to expire, sweep, or reconcile — the version of
 * this feature that kept drafts in a second table needed a scheduled job and an
 * expiry rule to do the same work worse.
 *
 * **One use case writes.** Commands, buttons, the modal and the picker all call
 * `ConfigureWelcomeUseCase`, so a change made one way cannot behave differently
 * from the same change made another.
 *
 * **Deleting it** is this directory, one line in `src/app/features.ts`, and
 * migration 0002. Nothing else refers to it.
 */
export function createWelcomeFeature(deps: WelcomeDeps): Feature {
  const repository = new PgWelcomeRepository(deps.database);

  const configure = new ConfigureWelcomeUseCase(repository, deps.cache);
  const compose = new ComposeGreetingUseCase(configure);

  return defineFeature({
    id: "welcome",
    commands: createWelcomeCommands(configure, compose, deps.messenger),
    components: createWelcomeComponents(configure),
    modals: createWelcomeModals(configure),
    events: [createMemberJoinedEvent(compose, deps.messenger, deps.logger)],
  });
}
