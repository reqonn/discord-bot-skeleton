import type { Database } from "#platform/database/database.contract.js";

import type { CheckOutcome, HealthCheck } from "../application/ports/health-check.port.js";

/**
 * Confirms the database answers, and how quickly.
 *
 * `SELECT 1` rather than a real query: this measures the round trip and the
 * pool, which is what "is the database reachable" means. Touching a table
 * would also measure that table's health, which is a different question.
 */
export class DatabaseHealthCheck implements HealthCheck {
  readonly name = "database";

  constructor(private readonly database: Database) {}

  async check(): Promise<CheckOutcome> {
    const startedAt = performance.now();
    await this.database.query("SELECT 1");

    return {
      name: this.name,
      healthy: true,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}
