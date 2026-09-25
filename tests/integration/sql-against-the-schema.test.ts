import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { filesUnder } from "../architecture/source-tree.js";

/**
 * Every statement the bot writes, checked against the schema it runs on.
 *
 * A repository's SQL is a string. Nothing typechecks it, nothing lints it, and
 * a column renamed in a migration goes on being named in a `SELECT` list until
 * somebody runs the command that uses it — in production, where it arrives as
 * an incident rather than a red build.
 *
 * The repository suites beside this one cover the statements they exercise.
 * This covers the rest, and the rest is where a rename hides: the `SELECT`
 * list, the join condition, the `ORDER BY` — the parts nobody writes twice.
 *
 * **Postgres is the checker, not a parser written here.** `PREPARE` plans a
 * statement without running it, so tables, columns, joins, operators and
 * parameter types are all resolved against the real migrated schema. A parser
 * of our own would be a second, worse implementation of the thing under the
 * statement, and it would disagree with Postgres exactly where it mattered.
 *
 * **What it does not cover:** a statement assembled by interpolation, which
 * arrives here as a template with a hole in. Said out loud rather than quietly
 * skipped — those have the most room to be wrong, and this is not what will
 * catch them.
 *
 * Skipped without a database, like the other integration suites. It grows with
 * the bot: two repositories today, and every one added after is checked the
 * day it is written.
 */

const DATABASE_URL = process.env["DATABASE_URL"] ?? "postgres://bot:bot@127.0.0.1:55432/bot";

/**
 * What a statement has to look like before Postgres is asked about it.
 *
 * The whole opening, not just the first word. Prose about SQL reads like SQL:
 * a doc comment beginning "with several text blocks…" that later says "a
 * departure *from* …" is a `WITH` and a `FROM` to a looser pattern.
 */
const STARTS =
  /^\s*(?:SELECT\s|INSERT\s+INTO\s|UPDATE\s|DELETE\s+FROM\s|WITH\s+[a-z_][a-z0-9_]*\s+AS\s*\()/iu;
const CLAUSE = /\b(?:FROM|INTO|SET|VALUES)\b/iu;

/** An ellipsis means prose; so does being short. A statement names what it acts on. */
function isStatement(sql: string): boolean {
  return STARTS.test(sql) && CLAUSE.test(sql) && !sql.includes("…") && sql.trim().length >= 25;
}

/** Backtick templates with no hole in them, and ordinary double-quoted strings. */
const TEMPLATE = /`([^`]*)`/gu;
const DOUBLE = /"((?:[^"\\]|\\.)*)"/gu;

interface Statement {
  readonly file: string;
  readonly sql: string;
}

function statementsIn(file: string): readonly Statement[] {
  const text = readFileSync(file, "utf8");
  const found: Statement[] = [];

  for (const match of text.matchAll(TEMPLATE)) {
    const sql = match[1] ?? "";
    if (!sql.includes("${") && isStatement(sql)) found.push({ file, sql: sql.trim() });
  }

  for (const match of text.matchAll(DOUBLE)) {
    const sql = match[1] ?? "";
    // TypeScript forbids a raw newline inside `"…"`, so a match spanning lines
    // is two unrelated quotes with a paragraph of prose between them.
    if (!sql.includes("\n") && isStatement(sql)) found.push({ file, sql: sql.trim() });
  }

  return found;
}

/**
 * Only the repositories.
 *
 * The migrations create the schema and the platform's own SQL speaks to the
 * catalogue rather than to a table, so neither is a claim about the shape this
 * is checking. A repository is.
 */
const statements = filesUnder("src", (path) => path.endsWith(".pg-repository.ts")).flatMap(
  statementsIn,
);

async function isReachable(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const reachable = await isReachable(DATABASE_URL);
const suite = reachable ? describe : describe.skip;

if (!reachable) {
  console.warn(
    "sql-against-the-schema.test.ts skipped: no PostgreSQL at DATABASE_URL. Run `pnpm db:start`.",
  );
}

let client: Client;

beforeAll(async () => {
  if (!reachable) return;
  client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client?.end();
});

suite("the SQL the bot writes", () => {
  it("finds the statements to check", () => {
    // A scan that found nothing would make the check below pass for the wrong
    // reason, and it is a regex over source files: the day a repository is
    // renamed or stops using a backtick, this is what says so.
    //
    // Five today, from two repositories. The floor is low deliberately — it
    // asks whether the scan still works, not whether a statement was deleted,
    // and a guard that fails on ordinary editing teaches people to raise it.
    expect(statements.length).toBeGreaterThan(2);
  });

  it("names only tables and columns the schema has", async () => {
    const broken: string[] = [];

    // Named per statement: `PREPARE` keeps the plan for the session, and
    // reusing a name would fail for a reason that is not the one looked for.
    for (const [index, one] of statements.entries()) {
      try {
        await client.query(`PREPARE checked_${String(index)} AS ${one.sql}`);
      } catch (error) {
        const said = error instanceof Error ? error.message.split("\n")[0] : String(error);
        broken.push(`${one.file}: ${said ?? ""}\n    ${one.sql.replaceAll(/\s+/gu, " ")}`);
      }
    }

    expect(
      broken,
      "Postgres planned every other statement against the schema and refused these",
    ).toEqual([]);
  }, 30_000);
});
