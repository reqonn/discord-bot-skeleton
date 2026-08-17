import type { Feature } from "#app/feature.contract.js";

import type { Logger } from "#platform/logging/logger.contract.js";

import type { Messenger } from "#discord/contracts/messenger.contract.js";

import { createHealthFeature } from "#features/bot/health/feature.js";
import { createPrefixFeature } from "#features/guild/prefix/feature.js";
import { createWelcomeFeature } from "#features/guild/welcome/feature.js";

import type { Infrastructure } from "./wiring.js";

/**
 * Every feature in the bot.
 *
 * One line each, with static imports. There is deliberately no filesystem
 * scanning: convention-based discovery reads as magic right up until a file is
 * named slightly wrong and silently never loads, at which point the bug is
 * invisible to the compiler, invisible in review, and only shows up as a
 * command that does not exist.
 *
 * Adding a feature means adding one line here. That is a feature of the design,
 * not an oversight — registration order and membership stay reviewable.
 */
export function createFeatures(
  infrastructure: Infrastructure,
  defaultPrefix: string,
  logger: Logger,
  messenger: Messenger,
): readonly Feature[] {
  return [
    createHealthFeature({
      database: infrastructure.database,
      cache: infrastructure.cache,
      cacheTier: infrastructure.cacheTier,
      logger,
    }),
    createPrefixFeature({
      database: infrastructure.database,
      cache: infrastructure.cache,
      defaultPrefix,
    }),
    createWelcomeFeature({
      database: infrastructure.database,
      cache: infrastructure.cache,
      logger,
      messenger,
    }),
  ];
}
