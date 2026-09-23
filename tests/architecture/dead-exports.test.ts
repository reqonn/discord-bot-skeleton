import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { filesUnder } from "./source-tree.js";

/**
 * Exports nothing anywhere refers to.
 *
 * `dependency-cruiser` catches an orphan *file*. It cannot catch an orphan
 * *export* inside a file that is otherwise imported, and that is where the
 * expensive defects live: a function written, exported, covered by a test,
 * and wired to nothing, in a file that looks alive. In the bot this skeleton
 * was extracted from, four shipped that way at once — a parser whose blocks
 * reached channels as literal text, a security check the comment promised,
 * a help path that answered fourteen prefixes with silence. Every one read
 * as covered. None of them ran.
 *
 * A test file counts as a reference: something exercised only by tests is
 * deliberate (`tests/support/` is entirely that), and something referenced
 * nowhere at all is not.
 */

/**
 * `scripts/` counts: `pnpm commands:deploy` is a real caller of
 * `deployCommands`, and without it the deployer read as dead.
 */
const ROOTS = ["src", "tests", "scripts"];

/**
 * Exports that are deliberately unreferenced, each with the reason.
 *
 * Keep this short. An entry here is a claim that something unused should
 * stay, and the honest answer is usually to delete it instead.
 */
const ALLOWED = new Map<string, string>([
  [
    "src/shared/errors/app-error.ts:ConflictError",
    "One of the closed error hierarchy. A gap in the set is worse than an unused member.",
  ],
  [
    "src/discord/contracts/authorization.contract.ts:requireGuildOwner",
    "One of the closed policy set a feature declares `authorize` from. Nothing in the skeleton's two features needs it; the next feature may, and a gap here reads as an ownership check nobody may express.",
  ],
  [
    "src/discord/contracts/authorization.contract.ts:anyOf",
    "The one combinator in the policy vocabulary. Without it the first feature to need 'admin or owner' writes its own, and the refusal wording drifts.",
  ],
  [
    "src/shared/types/snowflake.types.ts:toSnowflake",
    "The validating half of the snowflake API: what a trust boundary calls instead of the unchecked `asSnowflake`. Nothing in the skeleton accepts an id from user input yet.",
  ],
]);

/** Every named export in a file, ignoring types — an unused type is not a bug. */
function exportsIn(text: string): readonly string[] {
  const names: string[] = [];

  for (const match of text.matchAll(
    /^export (?:async )?function (\w+)|^export const (\w+)|^export class (\w+)/gm,
  )) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name !== undefined) names.push(name);
  }

  return names;
}

async function readAll(): Promise<{
  bodies: Map<string, string>;
  code: Map<string, string>;
}> {
  const paths = ROOTS.flatMap((root) => filesUnder(root, (path) => path.endsWith(".ts")));
  const bodies = new Map(
    await Promise.all(paths.map(async (path) => [path, await readFile(path, "utf8")] as const)),
  );
  // Stripped once per file rather than once per export.
  const code = new Map([...bodies].map(([path, text]) => [path, codeOf(text)] as const));
  return { bodies, code };
}

describe("every export", () => {
  it("is referred to somewhere outside its own file", async () => {
    const { bodies, code } = await readAll();

    // A guard on the guard: a broken walk would make this vacuously pass.
    expect(bodies.size).toBeGreaterThan(100);

    const dead: string[] = [];

    for (const [path, text] of bodies) {
      for (const name of exportsIn(text)) {
        if (ALLOWED.has(`${path}:${name}`)) continue;

        const word = new RegExp(`\\b${name}\\b`);

        // Matched against code with comments and string literals blanked out.
        // Matching raw text made any incidental mention count as a reference,
        // and this codebase names functions in prose constantly — a dead
        // export was laundered by a single sentence about it.
        const referenced = [...code].some(([other, body]) => other !== path && word.test(body));
        if (referenced) continue;

        // Used inside its own file is *over-exported*, not dead: untidy rather
        // than broken. The defect this gate exists for is code nothing runs at
        // all, so only a name that appears once — its own declaration — counts.
        const own = code.get(path) ?? "";
        const mentions = (own.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
        if (mentions <= 1) dead.push(`${path}: ${name}`);
      }
    }

    expect(dead, "these are exported and nothing refers to them").toEqual([]);
  }, 30_000);
});

/**
 * An exemption for something that is not actually unused.
 *
 * The list above suppresses a name, so an entry that has stopped being true
 * hides a live function instead of documenting a dead one. A list that cannot
 * rot is worth more than a list somebody remembers to check.
 */
describe("every exemption", () => {
  it("still points at something nothing refers to", async () => {
    const { code } = await readAll();

    const stale: string[] = [];
    for (const key of ALLOWED.keys()) {
      const at = key.lastIndexOf(":");
      const path = key.slice(0, at);
      const name = key.slice(at + 1);
      const own = code.get(path);
      if (own === undefined) {
        stale.push(`${key} (no such file)`);
        continue;
      }

      // Two regexes, not one reused: a `g`-flagged expression carries
      // `lastIndex` between calls.
      const anywhere = new RegExp(`\\b${name}\\b`);
      const everyMatch = new RegExp(`\\b${name}\\b`, "g");

      const reached = [...code].some(
        ([other, body]) => other !== path && other.startsWith("src/") && anywhere.test(body),
      );
      const here = (own.match(everyMatch) ?? []).length;
      if (reached || here > 1) stale.push(key);
    }

    expect(
      stale,
      "these are exempted from the dead-export check and are not dead — delete the entry",
    ).toEqual([]);
  });
});

/**
 * A rule in a feature domain, referred to only by its own test.
 *
 * The gate above counts a test as a reference, and says so: something
 * exercised only by tests is usually deliberate. That is exactly wrong for a
 * **domain rule**, which exists to be applied. A rule nothing applies is not a
 * tidy helper; it is a decision the bot does not make — and in the bot this
 * came from, two such rules were second answers to questions already answered
 * elsewhere, each with a passing test.
 */
describe("a domain rule", () => {
  it("is applied by something other than its own test", async () => {
    const { bodies, code } = await readAll();

    // Only what the running bot could reach. A test is not an application.
    const production = [...code].filter(([path]) => path.startsWith("src/"));
    const rules = production.filter(
      ([path]) => path.startsWith("src/features/") && path.includes("/domain/"),
    );

    // A guard on the guard: a broken walk would make this vacuously pass.
    expect(rules.length).toBeGreaterThan(2);

    const unapplied: string[] = [];
    for (const [path, own] of rules) {
      for (const name of exportsIn(bodies.get(path) ?? "")) {
        if (ALLOWED.has(`${path}:${name}`)) continue;

        const word = new RegExp(`\\b${name}\\b`);
        if (production.some(([other, body]) => other !== path && word.test(body))) continue;

        const mentions = (own.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length;
        if (mentions <= 1) unapplied.push(`${path}:${name}`);
      }
    }

    expect(
      unapplied,
      "these are domain rules the bot never applies — a passing test is not a caller",
    ).toEqual([]);
  });
});

/**
 * Whether a value may begin here, which is what makes a `/` a regex.
 *
 * Reads the last thing emitted: an operator, an opening bracket, a comma, a
 * semicolon or a keyword can only be followed by a value. A name, a number or
 * a closing bracket means the `/` divides it.
 */
function startsValue(emitted: string): boolean {
  const before = emitted.trimEnd();
  if (before === "") return true;

  const last = before.at(-1) ?? "";
  if ("=(,:[!&|?{;+-*%<>~^".includes(last)) return true;

  return /\b(?:return|typeof|case|in|of|do|else|yield|await)$/u.test(before);
}

/**
 * A file's code, with comments and string literals blanked.
 *
 * Character-scanning rather than a regular expression, because the two things
 * nest: a `//` inside a string is not a comment, and a quote inside a comment
 * does not open a string. Replaced with spaces rather than removed so every
 * offset — and therefore every `\b` boundary — stays where it was.
 */
function codeOf(source: string): string {
  const out: string[] = [];
  let index = 0;

  while (index < source.length) {
    const two = source.slice(index, index + 2);

    if (two === "//") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      out.push(" ".repeat(stop - index));
      index = stop;
      continue;
    }

    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      out.push(" ".repeat(stop - index));
      index = stop;
      continue;
    }

    // A template literal is part text and part *code*: `${helper(...)}` is a
    // call, and blanking it wholesale hides every function only ever called
    // from inside one.
    if (source[index] === "`") {
      let cursor = index + 1;
      out.push("`");

      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          out.push("  ");
          cursor += 2;
          continue;
        }
        if (source[cursor] === "`") break;

        if (source[cursor] === "$" && source[cursor + 1] === "{") {
          // Brace-matched rather than searched for, because an interpolation
          // may hold an object, another template, or a nested call.
          let depth = 0;
          let end = cursor + 1;
          for (; end < source.length; end += 1) {
            if (source[end] === "{") depth += 1;
            else if (source[end] === "}") {
              depth -= 1;
              if (depth === 0) break;
            }
          }

          const inner = source.slice(cursor, Math.min(end + 1, source.length));
          out.push(`\${${codeOf(inner.slice(2, -1))}}`);
          cursor = end + 1;
          continue;
        }

        out.push(" ");
        cursor += 1;
      }

      out.push(cursor < source.length ? "`" : "");
      index = Math.min(cursor + 1, source.length);
      continue;
    }

    // A regex literal is neither code to read nor a string to blank, and
    // mistaking one for a string is worse than either: `/["']+$/` opens a
    // double-quoted string at its character class, and the scanner then
    // blanks everything up to the next `"` anywhere in the file — every call
    // below it. Told apart from division by what precedes it.
    if (source[index] === "/" && startsValue(out.join(""))) {
      let cursor = index + 1;
      let inClass = false;
      let closed = false;

      while (cursor < source.length) {
        const at = source[cursor];
        if (at === "\\") {
          cursor += 2;
          continue;
        }
        // A newline inside what looked like a regex means it was not one.
        if (at === "\n") break;
        if (at === "[") inClass = true;
        else if (at === "]") inClass = false;
        else if (at === "/" && !inClass) {
          closed = true;
          break;
        }
        cursor += 1;
      }

      if (closed) {
        out.push(" ".repeat(cursor - index + 1));
        index = cursor + 1;
        continue;
      }
    }

    const quote = source[index];
    if (quote === '"' || quote === "'") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (source[cursor] === quote) break;
        cursor += 1;
      }

      const stop = Math.min(cursor + 1, source.length);
      // The quotes are kept so the token still ends where it did; only what is
      // between them is blanked.
      out.push(`${quote}${" ".repeat(Math.max(0, stop - index - 2))}${quote}`);
      index = stop;
      continue;
    }

    out.push(source[index] ?? "");
    index += 1;
  }

  return out.join("");
}
