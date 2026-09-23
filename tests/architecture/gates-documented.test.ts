import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { entriesIn } from "./source-tree.js";

/**
 * Every gate, listed where somebody looks for one.
 *
 * A rule that is held goes on being argued about when nobody can find it, and
 * a rule that is only written down reads as held. `docs/gates.md` is the
 * index, one row per gate with what it holds. This keeps it whole in both
 * directions: a new gate is listed, and a deleted one is not.
 */

const INDEX = "docs/gates.md";

/** A row's first cell: `| \`name\` |`, padded to the column as Prettier leaves it. */
const ROW = /^\| `([a-z0-9-]+)` +\|/gmu;

function listed(): readonly string[] {
  return [...readFileSync(INDEX, "utf8").matchAll(ROW)].map((match) => match[1] ?? "");
}

function gates(): readonly string[] {
  return entriesIn("tests/architecture")
    .filter((entry) => !entry.isDirectory && entry.name.endsWith(".test.ts"))
    .map((entry) => entry.name.replace(/\.test\.ts$/u, ""));
}

describe("the index of gates", () => {
  it("exists", () => {
    expect(existsSync(INDEX), `${INDEX} lists every architecture test`).toBe(true);
  });

  it("lists every gate", () => {
    const names = new Set(listed());
    const missing = gates().filter((gate) => !names.has(gate));

    expect(missing, `add a row to ${INDEX} saying what each of these holds`).toEqual([]);
  });

  it("lists nothing that is not a gate, and nothing twice", () => {
    const present = new Set(gates());
    const rows = listed();
    const stale = rows.filter((name) => !present.has(name));
    const twice = rows.filter((name, index) => rows.indexOf(name) !== index);

    expect([...stale, ...twice], `these rows in ${INDEX} name no gate, or repeat one`).toEqual([]);
  });
});
