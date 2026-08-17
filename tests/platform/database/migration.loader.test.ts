import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadMigrations } from "#platform/database/migration.loader.js";

let directory: string | undefined;

/** Writes a migration directory and returns its path. */
async function migrations(files: Record<string, string>): Promise<string> {
  directory = await mkdtemp(join(tmpdir(), "migrations-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents, "utf8");
  }
  return directory;
}

afterEach(async () => {
  if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("loadMigrations", () => {
  it("returns nothing for a directory that does not exist", async () => {
    // A fresh clone has no migrations; that is not an error.
    await expect(loadMigrations(join(tmpdir(), "definitely-not-here"))).resolves.toEqual([]);
  });

  it("pairs up and down files", async () => {
    const dir = await migrations({
      "0001_create-tickets.up.sql": "CREATE TABLE tickets ();",
      "0001_create-tickets.down.sql": "DROP TABLE tickets;",
    });

    const [migration] = await loadMigrations(dir);

    expect(migration).toMatchObject({
      id: "0001",
      name: "create-tickets",
      upSql: "CREATE TABLE tickets ();",
      downSql: "DROP TABLE tickets;",
    });
  });

  it("accepts an up file with no down file", async () => {
    const dir = await migrations({ "0001_create-tickets.up.sql": "SELECT 1;" });

    const [migration] = await loadMigrations(dir);

    expect(migration?.downSql).toBeUndefined();
  });

  it("orders by ordinal, not by directory listing", async () => {
    const dir = await migrations({
      "0002_second.up.sql": "SELECT 2;",
      "0001_first.up.sql": "SELECT 1;",
      "0003_third.up.sql": "SELECT 3;",
    });

    const loaded = await loadMigrations(dir);

    expect(loaded.map((m) => m.name)).toEqual(["first", "second", "third"]);
  });

  it("ignores files that are not SQL", async () => {
    const dir = await migrations({
      "0001_first.up.sql": "SELECT 1;",
      "README.md": "notes",
    });

    await expect(loadMigrations(dir)).resolves.toHaveLength(1);
  });

  describe("filenames", () => {
    it("rejects anything that does not state its order", async () => {
      // A directory where some files are numbered and some are not stops being
      // orderable, and the failure appears months later on a fresh database.
      const dir = await migrations({ "create-tickets.sql": "SELECT 1;" });

      await expect(loadMigrations(dir)).rejects.toThrow(/NNNN_kebab-name/);
    });

    it("rejects a non-kebab name", async () => {
      const dir = await migrations({ "0001_createTickets.up.sql": "SELECT 1;" });

      await expect(loadMigrations(dir)).rejects.toThrow(/NNNN_kebab-name/);
    });

    it("rejects two different names sharing one ordinal", async () => {
      const dir = await migrations({
        "0001_first.up.sql": "SELECT 1;",
        "0001_second.up.sql": "SELECT 2;",
      });

      await expect(loadMigrations(dir)).rejects.toThrow(/two names/);
    });

    it("rejects a down file with no up file", async () => {
      const dir = await migrations({ "0001_orphan.down.sql": "DROP TABLE x;" });

      await expect(loadMigrations(dir)).rejects.toThrow(/no \.up\.sql/);
    });
  });

  describe("sequence", () => {
    it("rejects a gap", async () => {
      // Usually means two branches each added a migration and one will apply
      // out of order on a database that has already seen the other.
      const dir = await migrations({
        "0001_first.up.sql": "SELECT 1;",
        "0003_third.up.sql": "SELECT 3;",
      });

      await expect(loadMigrations(dir)).rejects.toThrow(/gap/);
    });

    it("rejects a sequence that does not start at 0001", async () => {
      const dir = await migrations({ "0002_second.up.sql": "SELECT 2;" });

      await expect(loadMigrations(dir)).rejects.toThrow(/expected 0001/);
    });
  });

  describe("transactions", () => {
    it("wraps a migration in one by default", async () => {
      const dir = await migrations({ "0001_first.up.sql": "SELECT 1;" });

      expect((await loadMigrations(dir))[0]?.transactional).toBe(true);
    });

    it("honours the opt-out marker", async () => {
      // CREATE INDEX CONCURRENTLY cannot run inside a transaction.
      const dir = await migrations({
        "0001_first.up.sql": "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY x ON y (z);",
      });

      expect((await loadMigrations(dir))[0]?.transactional).toBe(false);
    });
  });

  describe("checksums", () => {
    it("is stable for identical content", async () => {
      const first = await loadMigrations(await migrations({ "0001_a.up.sql": "SELECT 1;" }));
      await rm(directory ?? "", { recursive: true, force: true });
      const second = await loadMigrations(await migrations({ "0001_a.up.sql": "SELECT 1;" }));

      expect(first[0]?.checksum).toBe(second[0]?.checksum);
    });

    it("changes when the migration changes", async () => {
      // This is what turns editing an applied migration into a startup failure
      // rather than a schema that silently differs per environment.
      const first = await loadMigrations(await migrations({ "0001_a.up.sql": "SELECT 1;" }));
      await rm(directory ?? "", { recursive: true, force: true });
      const second = await loadMigrations(await migrations({ "0001_a.up.sql": "SELECT 2;" }));

      expect(first[0]?.checksum).not.toBe(second[0]?.checksum);
    });
  });
});
