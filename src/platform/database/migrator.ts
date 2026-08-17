import { InfrastructureError } from "../../shared/errors/app-error.js";
import type { Logger } from "../logging/logger.contract.js";

import type { Database, Queryable } from "./database.contract.js";
import { loadMigrations, type Migration } from "./migration.loader.js";

/**
 * Advisory lock key, so two instances booting simultaneously cannot both apply
 * the same migration.
 *
 * The value is arbitrary but must never change: two versions of the bot using
 * different keys would not exclude each other, which is the entire point.
 */
const LOCK_KEY = 0x6d_69_67_72;

const TABLE = "schema_migrations";

export interface AppliedMigration {
  readonly id: string;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly Migration[];
}

/**
 * Applies versioned SQL migrations.
 *
 * Runs at startup, under a PostgreSQL session advisory lock, so rolling a
 * deploy with several instances is safe: the first to acquire the lock
 * migrates, the rest wait and then find nothing to do.
 *
 * Each migration commits on its own rather than the whole batch sharing one
 * transaction. A half-applied batch is recoverable — you fix the failing
 * migration and re-run — whereas a batch that rolls back after twenty minutes
 * of index building is not.
 */
export class Migrator {
  private readonly logger: Logger;

  constructor(
    private readonly database: Database,
    logger: Logger,
    private readonly directory: string,
  ) {
    this.logger = logger.child({ subsystem: "migrator" });
  }

  /** Applies every pending migration. Returns those it applied. */
  async up(): Promise<AppliedMigration[]> {
    return this.withLock(async (session) => {
      const migrations = await loadMigrations(this.directory);
      const applied = await this.readApplied(session);
      this.assertUnchanged(migrations, applied);

      const appliedIds = new Set(applied.map((entry) => entry.id));
      const pending = migrations.filter((migration) => !appliedIds.has(migration.id));

      if (pending.length === 0) {
        this.logger.debug("Database schema is current", { applied: applied.length });
        return [];
      }

      this.logger.info("Applying migrations", { count: pending.length });
      const results: AppliedMigration[] = [];
      for (const migration of pending) {
        results.push(await this.apply(session, migration));
      }
      return results;
    });
  }

  /** Reverts the most recent `steps` migrations. Development affordance. */
  async down(steps = 1): Promise<string[]> {
    return this.withLock(async (session) => {
      const migrations = await loadMigrations(this.directory);
      const applied = await this.readApplied(session);
      const target = applied.slice(-steps).reverse();
      const reverted: string[] = [];

      for (const entry of target) {
        const migration = migrations.find((candidate) => candidate.id === entry.id);
        if (migration?.downSql === undefined) {
          throw new InfrastructureError(
            `Migration ${entry.id}_${entry.name} has no .down.sql, so it cannot be reverted. Write a forward migration instead.`,
          );
        }

        await session.execute("BEGIN");
        try {
          await session.execute(migration.downSql);
          await session.execute(`DELETE FROM ${TABLE} WHERE id = $1`, [migration.id]);
          await session.execute("COMMIT");
        } catch (error) {
          await session.execute("ROLLBACK");
          throw error;
        }

        this.logger.info("Reverted migration", { id: migration.id, migration: migration.name });
        reverted.push(`${migration.id}_${migration.name}`);
      }

      return reverted;
    });
  }

  async status(): Promise<MigrationStatus> {
    return this.withLock(async (session) => {
      const migrations = await loadMigrations(this.directory);
      const applied = await this.readApplied(session);
      const appliedIds = new Set(applied.map((entry) => entry.id));

      return { applied, pending: migrations.filter((m) => !appliedIds.has(m.id)) };
    });
  }

  private async apply(session: Queryable, migration: Migration): Promise<AppliedMigration> {
    const startedAt = Date.now();
    const label = `${migration.id}_${migration.name}`;

    if (migration.transactional) {
      await session.execute("BEGIN");
      try {
        await session.execute(migration.upSql);
        await this.record(session, migration);
        await session.execute("COMMIT");
      } catch (error) {
        await session.execute("ROLLBACK");
        throw new InfrastructureError(`Migration ${label} failed`, { cause: error });
      }
    } else {
      // Opted out of transactions (CREATE INDEX CONCURRENTLY and friends). If
      // this fails partway there is nothing to roll back, which is why the
      // marker is opt-in and rare.
      try {
        await session.execute(migration.upSql);
        await this.record(session, migration);
      } catch (error) {
        throw new InfrastructureError(
          `Migration ${label} failed outside a transaction and may be partially applied. Inspect the schema before retrying.`,
          { cause: error },
        );
      }
    }

    const durationMs = Date.now() - startedAt;
    this.logger.info("Applied migration", {
      id: migration.id,
      migration: migration.name,
      durationMs,
    });

    return {
      id: migration.id,
      name: migration.name,
      checksum: migration.checksum,
      appliedAt: new Date(),
    };
  }

  private async record(session: Queryable, migration: Migration): Promise<void> {
    await session.execute(`INSERT INTO ${TABLE} (id, name, checksum) VALUES ($1, $2, $3)`, [
      migration.id,
      migration.name,
      migration.checksum,
    ]);
  }

  /**
   * Refuses to continue if an already-applied migration's file has changed.
   *
   * Editing an applied migration is silent locally — your database already has
   * the old version — and produces a different schema on every environment
   * that migrates afterwards. This turns that into a startup failure.
   */
  private assertUnchanged(
    migrations: readonly Migration[],
    applied: readonly AppliedMigration[],
  ): void {
    for (const entry of applied) {
      const migration = migrations.find((candidate) => candidate.id === entry.id);
      if (migration === undefined) continue;

      if (migration.checksum !== entry.checksum) {
        throw new InfrastructureError(
          `Migration ${entry.id}_${entry.name} has changed since it was applied. Revert the edit and add a new migration — editing an applied one leaves every environment with a different schema.`,
        );
      }
    }
  }

  private async readApplied(session: Queryable): Promise<AppliedMigration[]> {
    await session.execute(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id          text        PRIMARY KEY,
        name        text        NOT NULL,
        checksum    text        NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `);

    const rows = await session.query<{
      id: string;
      name: string;
      checksum: string;
      applied_at: Date;
    }>(`SELECT id, name, checksum, applied_at FROM ${TABLE} ORDER BY id`);

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      checksum: row.checksum,
      appliedAt: row.applied_at,
    }));
  }

  /**
   * Runs `work` on one connection, holding the advisory lock.
   *
   * **The statement timeout is lifted first, and that ordering is the point.**
   * The pool sets `statement_timeout` from config — two seconds by default,
   * chosen to sit under Discord's acknowledgement budget so a slow query cannot
   * cost an interaction. That is right for serving commands and wrong for
   * everything here, in two ways that both end in a failed boot:
   *
   *   - A migration is a statement too. `CREATE INDEX` on a real table, or a
   *     backfill, routinely runs for minutes. Under the serving timeout it is
   *     cancelled and the deploy fails with what reads like a database fault.
   *   - `pg_advisory_lock` *blocks*, and blocking is a statement waiting. So
   *     the second instance of a rolling deploy — the one the lock exists to
   *     make wait — would be cancelled two seconds in and crash at boot, which
   *     is precisely the collision the lock was added to prevent.
   *
   * Unlimited rather than merely larger: any number picked here is a number
   * that eventually kills a legitimate index build, and a migration that hangs
   * is visible as a boot that never finishes. The setting is per-session, so it
   * ends when the connection is released and never touches a serving query.
   */
  private withLock<T>(work: (session: Queryable) => Promise<T>): Promise<T> {
    return this.database.withSession(async (session) => {
      await session.execute("SET statement_timeout = 0");
      await session.execute("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
      try {
        return await work(session);
      } finally {
        await session.execute("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
      }
    });
  }
}
