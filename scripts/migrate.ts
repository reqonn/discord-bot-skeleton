import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadConfig } from "#platform/config/config.js";
import { Migrator } from "#platform/database/migrator.js";
import { PgDatabase } from "#platform/database/pg.database.js";
import { createLogger } from "#platform/logging/pino.logger.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import { isAppError } from "#shared/errors/app-error.js";

/**
 * Migration CLI.
 *
 *   pnpm db:migrate           apply everything pending
 *   pnpm db:migrate:status    show what is applied and what is not
 *   pnpm db:migrate:down      revert the most recent migration
 *   pnpm db:migrate:new <name>  scaffold the next numbered pair
 *
 * `up` also runs automatically at startup. This CLI exists for the cases
 * startup cannot serve: inspecting state, reverting in development, and
 * creating files with the right names.
 */

const MIGRATIONS_DIR = resolve(process.cwd(), "database", "migrations");

async function withMigrator<T>(work: (migrator: Migrator) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const logger = createLogger(config);
  const database = new PgDatabase(config, logger, new MetricsRegistry());

  try {
    return await work(new Migrator(database, logger, MIGRATIONS_DIR));
  } finally {
    await database.close();
  }
}

async function up(): Promise<void> {
  const applied = await withMigrator((migrator) => migrator.up());
  console.log(
    applied.length === 0
      ? "Schema is already current."
      : `Applied ${String(applied.length)} migration(s).`,
  );
}

async function down(): Promise<void> {
  const reverted = await withMigrator((migrator) => migrator.down(1));
  console.log(reverted.length === 0 ? "Nothing to revert." : `Reverted ${reverted.join(", ")}.`);
}

async function status(): Promise<void> {
  const { applied, pending } = await withMigrator((migrator) => migrator.status());

  console.log("");
  if (applied.length === 0 && pending.length === 0) {
    console.log("  No migrations exist yet. Create one with: pnpm db:migrate:new <name>");
  }

  for (const entry of applied) {
    console.log(`  applied  ${entry.id}_${entry.name}  (${entry.appliedAt.toISOString()})`);
  }
  for (const entry of pending) {
    console.log(`  PENDING  ${entry.id}_${entry.name}`);
  }
  console.log("");
}

/** Scaffolds the next pair. Numbering by hand is how sequences develop gaps. */
async function create(): Promise<void> {
  const name = process.argv[3];
  if (name === undefined || !/^[a-z0-9-]+$/.test(name)) {
    console.error(
      'Usage: pnpm db:migrate:new <kebab-case-name>   e.g. pnpm db:migrate:new "create-tickets"',
    );
    process.exit(1);
  }

  await mkdir(MIGRATIONS_DIR, { recursive: true });
  const existing = await readdir(MIGRATIONS_DIR);
  const highest = existing
    .map((file) => Number.parseInt(file.slice(0, 4), 10))
    .filter((value) => !Number.isNaN(value))
    .reduce((max, value) => Math.max(max, value), 0);

  const id = String(highest + 1).padStart(4, "0");
  const upPath = join(MIGRATIONS_DIR, `${id}_${name}.up.sql`);
  const downPath = join(MIGRATIONS_DIR, `${id}_${name}.down.sql`);

  await writeFile(
    upPath,
    [
      // Conventions live in the template rather than in a checked-in example
      // migration: they appear at the moment they are needed, and nothing
      // unused ships to every deployment to teach them.
      `-- ${id}_${name}`,
      "--",
      "-- Runs inside a transaction by default. Add the line",
      "--   -- migrate:no-transaction",
      "-- if this migration uses CREATE INDEX CONCURRENTLY or similar.",
      "--",
      // ASCII only, deliberately: this file is generated and then opened in
      // whatever editor and encoding the reader happens to have, and a stray
      // em dash rendering as mojibake in a migration is a bad first impression
      // of a project that is otherwise fussy about exactly this.
      "-- Conventions (docs/conventions.md):",
      "--   - tables are snake_case and plural: guild_settings, tickets",
      "--   - primary key is `id`, foreign keys `<singular>_id`",
      "--   - timestamps are `created_at` / `updated_at`, type timestamptz",
      "--   - Discord snowflakes are `text`, not bigint. They are identifiers,",
      "--     never arithmetic, and every API sends and receives them as strings",
      "--   - index what you filter and join on, in this file, now",
      "",
      "-- CREATE TABLE example (",
      "--   id         text        PRIMARY KEY,",
      "--   guild_id   text        NOT NULL,",
      "--   created_at timestamptz NOT NULL DEFAULT now()",
      "-- );",
      "-- CREATE INDEX example_guild_id_idx ON example (guild_id);",
      "",
      "",
    ].join("\n"),
    "utf8",
  );

  await writeFile(
    downPath,
    [
      `-- Reverts ${id}_${name}.`,
      "-- Delete this file if the change cannot be safely reverted; the runner",
      "-- will then refuse to roll it back rather than doing so incorrectly.",
      "",
      "",
    ].join("\n"),
    "utf8",
  );

  console.log(`Created:\n  ${upPath}\n  ${downPath}`);
}

const COMMANDS: Record<string, () => Promise<void>> = { up, down, status, new: create };

const command = process.argv[2] ?? "up";
const run = COMMANDS[command];

if (run === undefined) {
  console.error(
    `Unknown command "${command}". Expected one of: ${Object.keys(COMMANDS).join(", ")}`,
  );
  process.exit(1);
}

run().catch((error: unknown) => {
  console.error(`\n${isAppError(error) ? (error.detail ?? error.message) : String(error)}\n`);
  process.exit(1);
});
