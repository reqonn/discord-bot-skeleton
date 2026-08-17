import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { InfrastructureError } from "../../shared/errors/app-error.js";

/**
 * Statements such as CREATE INDEX CONCURRENTLY cannot run inside a
 * transaction. A migration opts out by declaring this marker on its own line.
 */
const NO_TRANSACTION_MARKER = "-- migrate:no-transaction";

const FILE_PATTERN = /^(\d{4})_([a-z0-9-]+)\.(up|down)\.sql$/;

export interface Migration {
  /** Zero-padded ordinal: "0001". Ordering is by this, not by filename sort. */
  readonly id: string;
  readonly name: string;
  readonly upSql: string;
  readonly downSql: string | undefined;
  /** Detects an applied migration whose file has since been edited. */
  readonly checksum: string;
  readonly transactional: boolean;
}

/**
 * Reads and validates the migration directory.
 *
 * Strict about filenames on purpose: `0007_add-ticket-index.up.sql` sorts
 * correctly, states its order, and reads as a sentence. A directory where some
 * files are `add_index.sql` and others `0007-index.SQL` stops being orderable,
 * and the failure shows up as migrations applying in the wrong sequence on a
 * fresh database months later.
 */
export async function loadMigrations(directory: string): Promise<Migration[]> {
  const entries = await readDirectory(directory);
  const sqlFiles = entries.filter((entry) => entry.endsWith(".sql"));

  const malformed = sqlFiles.filter((entry) => !FILE_PATTERN.test(entry));
  if (malformed.length > 0) {
    throw new InfrastructureError(
      `Migration filenames must match NNNN_kebab-name.(up|down).sql — rejected: ${malformed.join(", ")}`,
    );
  }

  const byId = new Map<string, { name: string; up?: string; down?: string }>();

  for (const file of sqlFiles) {
    const match = FILE_PATTERN.exec(file);
    /* c8 ignore next */
    if (match === null) continue;

    const [, id = "", name = "", direction = ""] = match;
    const sql = await readFile(join(directory, file), "utf8");

    const existing = byId.get(id) ?? { name };
    if (existing.name !== name) {
      throw new InfrastructureError(
        `Migration ${id} has two names: "${existing.name}" and "${name}". One ordinal, one migration.`,
      );
    }

    byId.set(id, { ...existing, [direction]: sql });
  }

  const migrations = [...byId.entries()]
    .map(([id, files]): Migration => {
      if (files.up === undefined) {
        throw new InfrastructureError(
          `Migration ${id}_${files.name} has a .down.sql but no .up.sql.`,
        );
      }
      return {
        id,
        name: files.name,
        upSql: files.up,
        downSql: files.down,
        checksum: createHash("sha256").update(files.up).digest("hex").slice(0, 16),
        transactional: !files.up.includes(NO_TRANSACTION_MARKER),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  assertContiguous(migrations);
  return migrations;
}

/**
 * A gap in the sequence usually means a migration was merged from one branch
 * and another from a second, and one of them will apply out of order on a
 * database that has already seen the other. Better to fail at deploy time.
 */
function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    const expected = String(index + 1).padStart(4, "0");
    if (migration.id !== expected) {
      throw new InfrastructureError(
        `Migration sequence has a gap: expected ${expected}, found ${migration.id}_${migration.name}. Renumber so the sequence is contiguous.`,
      );
    }
  });
}

async function readDirectory(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
