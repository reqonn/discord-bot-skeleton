import { ok, type Result } from "#shared/result/result.js";

import type { CheckOutcome, HealthCheck } from "./ports/health-check.port.js";
import type { RuntimeInfo } from "./ports/runtime-info.port.js";

export interface HealthReport {
  readonly healthy: boolean;
  readonly checks: readonly CheckOutcome[];
  /** Milliseconds since the process started. */
  readonly uptimeMs: number;
  /** Resident set size in bytes. */
  readonly memoryBytes: number;
}

/**
 * Reports on every dependency this process wired.
 *
 * Returns `ok` even when dependencies are unhealthy: a health report that
 * successfully reports bad news is a success. Failing here would mean the one
 * command you run when things are broken is the one that breaks.
 */
export class CheckHealthUseCase {
  constructor(
    private readonly checks: readonly HealthCheck[],
    private readonly runtime: RuntimeInfo,
  ) {}

  async execute(): Promise<Result<HealthReport>> {
    // In parallel, so the reported latency of one dependency is not the sum of
    // the ones queued before it.
    const outcomes = await Promise.all(this.checks.map((check) => this.runSafely(check)));

    return ok({
      healthy: outcomes.every((outcome) => outcome.healthy),
      checks: outcomes,
      uptimeMs: this.runtime.uptimeMs(),
      memoryBytes: this.runtime.memoryBytes(),
    });
  }

  private async runSafely(check: HealthCheck): Promise<CheckOutcome> {
    try {
      return await check.check();
    } catch (error) {
      // A check that throws is a dependency that is down — which is exactly
      // what the report exists to say.
      return {
        name: check.name,
        healthy: false,
        latencyMs: 0,
        detail: error instanceof Error ? error.message : "check failed",
      };
    }
  }
}
