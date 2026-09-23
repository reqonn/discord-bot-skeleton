import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { filesUnder } from "./source-tree.js";

/**
 * "Please try again."
 *
 * The one sentence that is wrong wherever it appears. On a refusal it is bad
 * advice: the person gets the same refusal, and the thing they could change is
 * never named. On a fault it is never seen — a fault is answered with an
 * incident code (`say.unexpected`), and the error's own `userMessage` only
 * reaches the logs — so it is a line written for somebody who will not read it.
 *
 * It gets written anyway, one per error class, because each file copies the
 * last. A wait with a known end is different and stays: "try again in 3s"
 * tells somebody *when*, which is the one thing a retry needs. The bare
 * sentence says nothing, so it is banned.
 */

const BARE_RETRY = /please try again/iu;

/** Every source file the bot runs. */
function sourceFiles(): readonly string[] {
  return filesUnder("src", (path) => path.endsWith(".ts"));
}

/** The text of every string and template literal in a file. Comments are not strings. */
function stringsIn(path: string): readonly { readonly at: string; readonly text: string }[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );
  const found: { at: string; text: string }[] = [];

  const visit = (node: ts.Node): void => {
    const text =
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
        ? node.text
        : ts.isTemplateExpression(node)
          ? [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("…")
          : null;

    if (text !== null) {
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      found.push({ at: `${path}:${String(line)}`, text });
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

const strings = sourceFiles().flatMap((path) => stringsIn(path));

describe("what the bot says when something did not happen", () => {
  /** A walk that found nothing would pass the assertion below silently. */
  it("reads the strings it is judging", () => {
    expect(strings.length).toBeGreaterThan(100);
  });

  it("never says a bare 'Please try again'", () => {
    const bare = strings
      .filter((string) => BARE_RETRY.test(string.text))
      .map((string) => `${string.at}  ${string.text}`);

    expect(
      bare,
      "on a refusal, name what to change; on a fault, the incident code is what is shown and " +
        "this text only reaches the logs; on a wait, say when",
    ).toEqual([]);
  });
});
