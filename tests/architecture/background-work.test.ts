import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { filesUnder } from "./source-tree.js";

/**
 * Work the process starts and does not wait for.
 *
 * `void promise` tells the linter a promise was let go on purpose. What it
 * lets go of is the *failure*: a rejection nobody handles reaches
 * `unhandledRejection`, and src/main.ts treats that as fatal — so one
 * background notification Discord refused, or one job tick whose lease Redis
 * could not grant, takes the whole process down for every guild it serves.
 *
 * This is the defect that arrives in bulk rather than one at a time: it costs
 * nothing to write, looks deliberate, and every feature added afterwards
 * copies the shape from the one beside it. Thirty-seven were found at once in
 * the bot this skeleton was extracted from.
 *
 * So a promise that is let go has to say what happens when it fails: through
 * `detach(work, logger, what)` in platform/logging/logger.contract.ts, or with
 * a handler of its own on the end.
 */

/**
 * Calls whose promise cannot reject, and why not.
 *
 * Keyed by the called expression as written. An entry is a guarantee kept
 * somewhere else, so its reason has to name where.
 */
const NEVER_REJECTS: Readonly<Record<string, string>> = {};

/** Every source file the bot runs. */
function sourceFiles(): readonly string[] {
  return filesUnder("src", (path) => path.endsWith(".ts"));
}

interface LetGo {
  readonly at: string;
  readonly callee: string;
  readonly handled: boolean;
}

/** Ends in a handler: `.catch(…)`, or `.then(…, …)` with its rejection branch. */
function endsInHandler(call: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(call.expression)) return false;
  const method = call.expression.name.text;
  return method === "catch" || (method === "then" && call.arguments.length >= 2);
}

function letGoIn(path: string): readonly LetGo[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );
  const found: LetGo[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isVoidExpression(node)) {
      let operand: ts.Expression = node.expression;
      while (ts.isParenthesizedExpression(operand)) operand = operand.expression;

      if (ts.isCallExpression(operand)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        found.push({
          at: `${path}:${String(line)}`,
          callee: operand.expression.getText(source).replace(/\s+/g, ""),
          handled: endsInHandler(operand),
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

const found = sourceFiles().flatMap((path) => letGoIn(path));

describe("work nobody waits for", () => {
  it("says what happens when it fails", () => {
    const unhandled = found
      .filter((call) => !call.handled && !(call.callee in NEVER_REJECTS))
      .map((call) => `${call.at}  void ${call.callee}(…)`);

    expect(
      unhandled,
      "each of these lets a failure escape as an unhandled rejection, which stops the process. " +
        "Wrap it in detach(work, logger, what), end it in .catch, or add the call to " +
        "NEVER_REJECTS with where that guarantee is kept",
    ).toEqual([]);
  });

  /** An exemption for a call that is gone is one nobody is reading any more. */
  it("keeps no exemption nothing calls", () => {
    const called = new Set(found.map((call) => call.callee));
    const stale = Object.keys(NEVER_REJECTS).filter((callee) => !called.has(callee));

    expect(stale, "these exemptions no longer match a call — delete them").toEqual([]);
  });

  it("makes every exemption explain itself", () => {
    for (const [callee, reason] of Object.entries(NEVER_REJECTS)) {
      expect(reason.length, `${callee} needs a real reason`).toBeGreaterThan(30);
    }
  });

  /**
   * A walk that read nothing would pass the first assertion silently, which is
   * how a gate stops being a gate without anybody noticing.
   *
   * Two canaries, because the first assertion passing is ambiguous: it means
   * either "nothing lets a failure escape" or "the walk found no files". This
   * separates them, and then checks the convention it exists to enforce is
   * actually the one in use.
   */
  it("reads the whole source tree", () => {
    expect(sourceFiles().length).toBeGreaterThan(50);
  });

  it("finds detach actually being used, rather than the rule being vacuous", () => {
    const users = sourceFiles().filter(
      (path) =>
        !path.endsWith("logger.contract.ts") && readFileSync(path, "utf8").includes("detach("),
    );

    expect(
      users.length,
      "nothing calls detach — either the helper is dead or work is being let go another way",
    ).toBeGreaterThan(2);
  });
});
