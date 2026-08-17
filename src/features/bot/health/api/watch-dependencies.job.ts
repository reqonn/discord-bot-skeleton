import type { Job } from "#platform/jobs/job.contract.js";
import type { Logger } from "#platform/logging/logger.contract.js";

import type { CheckHealthUseCase } from "../application/check-health.usecase.js";

/** Often enough to notice within a coffee break, rare enough to cost nothing. */
const EVERY_MS = 5 * 60 * 1_000;

/**
 * Notices a dependency going down before a user does.
 *
 * `/ping` and `/readyz` both answer the same question, and both only when
 * something asks. Between them, a database that fell over at 3am is discovered
 * by whoever runs the next command — which is a user, and the first they know
 * of it is an error. This asks on a schedule instead, so the log carries the
 * moment it happened rather than the moment somebody tripped over it.
 *
 * A job descriptor is a trigger, exactly like a command: it calls a use case
 * and contains no logic of its own. That is what stops the same rule existing
 * twice, once for users and once for the scheduler.
 *
 * `singleton: false` because this only reads, and because each instance has its
 * own pool and its own cache — the answer is per-process, so every process
 * should be asking. Anything with an effect sets it true, and the scheduler
 * then takes a lock through the `Lock` port: a process mutex without Redis, a
 * lease with it.
 */
export function createWatchDependenciesJob(check: CheckHealthUseCase, logger: Logger): Job {
  return {
    id: "health.watch-dependencies",
    everyMs: EVERY_MS,
    // Lets the boot finish before the first check competes with it.
    delayMs: 30_000,
    singleton: false,
    run: async () => {
      const report = await check.execute();
      // The use case reports bad news as a success — a health check that fails
      // to report is the one thing worse than an unhealthy dependency.
      if (!report.ok || report.value.healthy) return;

      logger.warn("A dependency is unhealthy", {
        unhealthy: report.value.checks.filter((outcome) => !outcome.healthy).map((o) => o.name),
      });
    },
  };
}
