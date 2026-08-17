import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "#platform/config/config.js";
import { Migrator } from "#platform/database/migrator.js";
import { PgDatabase } from "#platform/database/pg.database.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import { PgGuildPrefixRepository } from "#features/guild/prefix/infrastructure/guild-prefix.pg-repository.js";
import { PgWelcomeRepository } from "#features/guild/welcome/infrastructure/welcome.pg-repository.js";

import { asSnowflake } from "#shared/types/snowflake.types.js";

import { MemoryLogger } from "#testing/memory.logger.js";

/**
 * The database layer, against a real PostgreSQL.
 *
 * These exist because a mocked `pg` proves nothing. A fake repository proves
 * the use case above it is correct and says nothing about whether the SQL
 * parses, whether the upsert conflicts on the right column, or whether a
 * timestamp comes back as a Date. The only thing that answers those is a
 * server, so this suite talks to one.
 *
 * It also covers the parts of the platform with no unit test worth writing:
 * the pool's error wrapping and its statement timeout, and the migrator's
 * advisory lock, checksum guard and rollback.
 *
 * Skipped when there is no database reachable, exactly as the Redis suite is,
 * so `pnpm verify` still passes on a machine that has not run `pnpm setup`.
 * CI always has one.
 */

const DATABASE_URL = process.env["DATABASE_URL"];

const config = loadConfig({
  DISCORD_TOKEN: "token",
  DISCORD_CLIENT_ID: "1",
  DATABASE_URL: DATABASE_URL ?? "postgres://bot:bot@127.0.0.1:55432/bot",
  // Short on purpose: one test proves a pathological query is cut off rather
  // than left to burn an interaction's budget.
  DATABASE_STATEMENT_TIMEOUT_MS: "1000",
});

const reachable = await isReachable(config.database.url);
const suite = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn("database.test.ts skipped: no PostgreSQL at DATABASE_URL. Run `pnpm db:start`.");
}

let database: PgDatabase;

beforeAll(() => {
  if (!reachable) return;
  database = new PgDatabase(config, new MemoryLogger(), new MetricsRegistry());
});

afterAll(async () => {
  await database?.close();
});

suite("PgDatabase", () => {
  beforeEach(async () => {
    await database.execute("DROP TABLE IF EXISTS probe");
    await database.execute("CREATE TABLE probe (id text PRIMARY KEY, n int NOT NULL)");
  });

  it("round-trips typed rows", async () => {
    await database.execute("INSERT INTO probe (id, n) VALUES ($1, $2)", ["a", 1]);

    const rows = await database.query<{ id: string; n: number }>("SELECT id, n FROM probe");

    expect(rows).toEqual([{ id: "a", n: 1 }]);
  });

  it("reports how many rows a write touched", async () => {
    await database.execute("INSERT INTO probe (id, n) VALUES ($1, $2), ($3, $4)", ["a", 1, "b", 2]);

    await expect(database.execute("UPDATE probe SET n = n + 1")).resolves.toBe(2);
  });

  it("refuses a queryOne that matched more than one row", async () => {
    // Silently returning the first would be a bug that only shows up as wrong
    // data much later, in a feature that assumed the query was unique.
    await database.execute("INSERT INTO probe (id, n) VALUES ($1, $2), ($3, $4)", ["a", 1, "b", 2]);

    await expect(database.queryOne("SELECT * FROM probe")).rejects.toThrow(/matched 2 rows/);
  });

  it("returns undefined rather than throwing when queryOne matches nothing", async () => {
    await expect(database.queryOne("SELECT * FROM probe WHERE id = $1", ["nope"])).resolves.toBe(
      undefined,
    );
  });

  it("never lets a driver message reach a user", async () => {
    // The driver puts parameter values in its message and the connection
    // string on connection errors. Neither belongs anywhere a user can see.
    const failure = await database
      .query("SELECT * FROM does_not_exist")
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "INFRASTRUCTURE_FAILURE" });
    expect((failure as { userMessage: string }).userMessage).not.toContain("does_not_exist");
  });

  it("cuts off a query that runs past the statement timeout", async () => {
    // The guard that stops one pathological query burning the Discord
    // acknowledgement budget. Configured at 1s for this suite.
    await expect(database.query("SELECT pg_sleep(3)")).rejects.toThrow();
  });

  describe("transactions", () => {
    it("commits everything or nothing", async () => {
      await database.transaction(async (tx) => {
        await tx.execute("INSERT INTO probe (id, n) VALUES ($1, $2)", ["a", 1]);
        await tx.execute("INSERT INTO probe (id, n) VALUES ($1, $2)", ["b", 2]);
      });

      await expect(database.query("SELECT id FROM probe ORDER BY id")).resolves.toHaveLength(2);
    });

    it("rolls back on a throw, leaving no half-written state", async () => {
      await expect(
        database.transaction(async (tx) => {
          await tx.execute("INSERT INTO probe (id, n) VALUES ($1, $2)", ["a", 1]);
          throw new Error("changed my mind");
        }),
      ).rejects.toThrow("changed my mind");

      await expect(database.query("SELECT id FROM probe")).resolves.toEqual([]);
    });

    it("rolls back when the database itself refuses the write", async () => {
      await expect(
        database.transaction(async (tx) => {
          await tx.execute("INSERT INTO probe (id, n) VALUES ($1, $2)", ["a", 1]);
          await tx.execute("INSERT INTO probe (id, n) VALUES ($1, $2)", ["a", 2]);
        }),
      ).rejects.toThrow();

      await expect(database.query("SELECT id FROM probe")).resolves.toEqual([]);
    });
  });

  it("is safe to close more than once", async () => {
    // A failed boot runs the shutdown sequence, and a signal arriving during
    // that would otherwise turn a clean teardown into a logged failure.
    const second = new PgDatabase(config, new MemoryLogger(), new MetricsRegistry());

    await second.close();
    await expect(second.close()).resolves.toBeUndefined();
  });
});

suite("the shipped repositories", () => {
  const GUILD = asSnowflake("999000000000000001");
  const CHANNEL = asSnowflake("999000000000000002");

  beforeAll(async () => {
    // Applies the real migrations to whatever database this is pointed at,
    // which is the only way these tests can run on a clean CI service — and it
    // means every push also proves the shipped SQL applies from nothing.
    await new Migrator(database, new MemoryLogger(), "database/migrations").up();
  });

  beforeEach(async () => {
    await database.execute("DELETE FROM guild_prefixes WHERE guild_id = $1", [GUILD]);
    await database.execute("DELETE FROM welcome_settings WHERE guild_id = $1", [GUILD]);
  });

  it("stores and reads a guild prefix", async () => {
    const repository = new PgGuildPrefixRepository(database);

    await expect(repository.find(GUILD)).resolves.toBeUndefined();

    await repository.save(GUILD, "?");
    await expect(repository.find(GUILD)).resolves.toBe("?");
  });

  it("upserts a prefix rather than failing on the second save", async () => {
    // The bug an INSERT would have: a guild changing its prefix twice.
    const repository = new PgGuildPrefixRepository(database);

    await repository.save(GUILD, "?");
    await repository.save(GUILD, ">");

    await expect(repository.find(GUILD)).resolves.toBe(">");
  });

  it("removes a prefix", async () => {
    const repository = new PgGuildPrefixRepository(database);
    await repository.save(GUILD, "?");

    await repository.clear(GUILD);

    await expect(repository.find(GUILD)).resolves.toBeUndefined();
  });

  it("round-trips welcome settings, nulls included", async () => {
    // `channel_id` is nullable and comes back as null rather than undefined;
    // the mapping either handles that or the panel renders "<#null>".
    const repository = new PgWelcomeRepository(database);

    await repository.saveSettings({
      guildId: GUILD,
      channelId: null,
      message: "Welcome {user}",
      enabled: false,
    });

    await expect(repository.findSettings(GUILD)).resolves.toEqual({
      guildId: GUILD,
      channelId: null,
      message: "Welcome {user}",
      enabled: false,
    });
  });

  it("upserts welcome settings on every field", async () => {
    const repository = new PgWelcomeRepository(database);

    await repository.saveSettings({
      guildId: GUILD,
      channelId: null,
      message: "first",
      enabled: false,
    });
    await repository.saveSettings({
      guildId: GUILD,
      channelId: CHANNEL,
      message: "second",
      enabled: true,
    });

    await expect(repository.findSettings(GUILD)).resolves.toMatchObject({
      channelId: CHANNEL,
      message: "second",
      enabled: true,
    });
  });
});

/** Runs one statement on the server itself, outside any pooled connection. */
async function withAdmin(work: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ connectionString: config.database.url });

  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
}

function scratchUrl(name: string): string {
  const url = new URL(config.database.url);
  url.pathname = `/${name}`;
  return url.toString();
}

/** Whether anything is listening, without failing the run when nothing is. */
async function isReachable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2_000 });

  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * The migrator gets a database of its own.
 *
 * It reads and writes `schema_migrations`, and the working database already has
 * the two real migrations recorded in it — so a test fixture numbered 0001
 * would collide with `0001_create-guild-prefixes` and be reported as an edited
 * migration. A scratch database is the only isolation that is actually true;
 * anything else tests the migrator against a table it does not own.
 */
suite("Migrator", () => {
  const SCRATCH = "roki_migrator_test";
  let scratch: PgDatabase;
  let directory: string;

  beforeAll(async () => {
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
      await client.query(`CREATE DATABASE ${SCRATCH}`);
    });

    scratch = new PgDatabase(
      { ...config, database: { ...config.database, url: scratchUrl(SCRATCH) } },
      new MemoryLogger(),
      new MetricsRegistry(),
    );
  });

  afterAll(async () => {
    await scratch?.close();
    await withAdmin(async (client) => {
      await client.query(`DROP DATABASE IF EXISTS ${SCRATCH}`);
    });
  });

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "roki-migrations-"));
    await scratch.execute("DROP TABLE IF EXISTS schema_migrations");
    await scratch.execute("DROP TABLE IF EXISTS probe_migrated");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function migrator(): Migrator {
    return new Migrator(scratch, new MemoryLogger(), directory);
  }

  async function write(id: string, up: string, down?: string): Promise<void> {
    await writeFile(join(directory, `${id}_probe.up.sql`), up, "utf8");
    if (down !== undefined) await writeFile(join(directory, `${id}_probe.down.sql`), down, "utf8");
  }

  it("applies a pending migration, then finds nothing to do", async () => {
    await write("0001", "CREATE TABLE probe_migrated (id text PRIMARY KEY);");

    await expect(migrator().up()).resolves.toHaveLength(1);
    // Idempotence is the property that makes running migrations at every boot
    // safe, which is what lets a deploy be one step.
    await expect(migrator().up()).resolves.toEqual([]);
  });

  it("runs a migration that takes longer than a query is allowed to", async () => {
    // The regression this exists for: the pool sets a statement timeout so a
    // slow query cannot cost an interaction, and migrations inherited it — so
    // any real CREATE INDEX would have been cancelled at boot. The migrator
    // lifts it for its own session.
    await write("0001", "SELECT pg_sleep(2); CREATE TABLE probe_migrated (id text PRIMARY KEY);");

    await expect(migrator().up()).resolves.toHaveLength(1);
  });

  it("waits rather than colliding when two instances migrate at once", async () => {
    // The advisory lock, which only works because the statement timeout is
    // lifted before it is taken — blocking is a statement waiting, so the
    // instance the lock exists to make wait would otherwise be cancelled.
    await write("0001", "SELECT pg_sleep(1); CREATE TABLE probe_migrated (id text PRIMARY KEY);");

    const [first, second] = await Promise.all([migrator().up(), migrator().up()]);

    // Exactly one applied it; the other found the work already done.
    expect(first.length + second.length).toBe(1);
  });

  it("refuses to run when an applied migration has been edited", async () => {
    // Editing an applied migration is silent locally and produces a different
    // schema everywhere that migrates afterwards.
    await write("0001", "CREATE TABLE probe_migrated (id text PRIMARY KEY);");
    await migrator().up();

    await write("0001", "CREATE TABLE probe_migrated (id text PRIMARY KEY, extra text);");

    await expect(migrator().up()).rejects.toThrow(/has changed since it was applied/);
  });

  it("reverts a migration that shipped a down", async () => {
    await write(
      "0001",
      "CREATE TABLE probe_migrated (id text PRIMARY KEY);",
      "DROP TABLE probe_migrated;",
    );
    await migrator().up();

    await expect(migrator().down()).resolves.toEqual(["0001_probe"]);
    await expect(migrator().status()).resolves.toMatchObject({ pending: [expect.anything()] });
  });

  it("refuses to revert one that did not, rather than guessing", async () => {
    await write("0001", "CREATE TABLE probe_migrated (id text PRIMARY KEY);");
    await migrator().up();

    await expect(migrator().down()).rejects.toThrow(/no \.down\.sql/);
  });
});
