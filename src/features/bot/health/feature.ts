import { defineFeature, type Feature } from "#app/feature.contract.js";

import type { Cache } from "#platform/cache/cache.contract.js";
import type { Database } from "#platform/database/database.contract.js";
import type { Logger } from "#platform/logging/logger.contract.js";

import { createPingCommand } from "./api/ping.command.js";
import { createWatchDependenciesJob } from "./api/watch-dependencies.job.js";
import { CheckHealthUseCase } from "./application/check-health.usecase.js";
import { CacheHealthCheck } from "./infrastructure/cache.health-check.js";
import { DatabaseHealthCheck } from "./infrastructure/database.health-check.js";
import { ProcessRuntimeInfo } from "./infrastructure/process.runtime-info.js";

export interface HealthDeps {
  readonly database: Database;
  readonly cache: Cache;
  /** "memory" or "tiered" — surfaced by /ping so the running mode is visible. */
  readonly cacheTier: string;
  readonly logger: Logger;
}

/**
 * The smallest complete feature.
 *
 * Notice what is absent: there is no `domain/` directory, because a health
 * check has no business rules to protect. Layers appear when they are earned.
 * Creating an empty domain folder "for consistency" would teach the opposite of
 * what the architecture is for.
 *
 * One use case, reached two ways: `/ping` when somebody asks, and a job every
 * five minutes so a dependency that fails at 3am is in the log at 3am rather
 * than whenever the next user trips over it. Adapters are triggers; the thing
 * they trigger is written once.
 */
export function createHealthFeature(deps: HealthDeps): Feature {
  const checkHealth = new CheckHealthUseCase(
    [new DatabaseHealthCheck(deps.database), new CacheHealthCheck(deps.cache, deps.cacheTier)],
    new ProcessRuntimeInfo(),
  );

  return defineFeature({
    id: "health",
    commands: [createPingCommand(checkHealth)],
    jobs: [createWatchDependenciesJob(checkHealth, deps.logger)],
  });
}
