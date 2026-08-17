import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The architecture rules, asserted against the source itself.
 *
 * ESLint and dependency-cruiser already enforce most of this, and these tests
 * deliberately overlap them. The overlap is the point: a lint rule can be
 * disabled in a config file or suppressed inline, and neither shows up in a
 * diff as obviously as a failing test named after the rule it protects.
 *
 * They also cover the one rule no lint rule expresses well — RULE 8, that
 * environment branching lives only in the composition root.
 *
 * Each test names the rule it guards, so a failure points at
 * docs/architecture.md rather than at a regex.
 */

const SRC = join(process.cwd(), "src");
const TESTS = join(process.cwd(), "tests");

interface SourceFile {
  /** Posix-style path relative to the repo root, e.g. "src/app/wiring.ts". */
  readonly path: string;
  readonly text: string;
}

async function readSourceFiles(roots: readonly string[]): Promise<SourceFile[]> {
  const files: SourceFile[] = [];

  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith(".ts")) {
        files.push({
          path: relative(process.cwd(), full).split(sep).join("/"),
          text: await readFile(full, "utf8"),
        });
      }
    }
  }

  for (const root of roots) await walk(root);
  return files;
}

/** Shipped code. Nothing under src/ is a test — the suite below proves it. */
const production = await readSourceFiles([SRC]);
const tests = await readSourceFiles([TESTS]);
const sources = [...production, ...tests];

/** Reports offenders by path, so a failure says which file rather than just "false". */
function offenders(files: readonly SourceFile[], pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(file.text)).map((file) => file.path);
}

describe("architecture", () => {
  it("has source files to check", () => {
    // Guards the guard: a broken walk would make every test below pass on an
    // empty list, which is the worst possible way for these to fail.
    expect(production.length).toBeGreaterThan(50);
  });

  describe("RULE 1 — discord.js lives only in src/discord", () => {
    it("is not imported anywhere else", () => {
      const outside = production.filter((file) => !file.path.startsWith("src/discord/"));

      expect(offenders(outside, /from "discord\.js"|from "@discordjs\//)).toEqual([]);
    });

    it("does not leak through src/discord/contracts either", () => {
      // Feature adapters import the contracts. If a contract imported the
      // library, every feature would transitively depend on it and the whole
      // boundary would be decorative.
      const contracts = production.filter((file) => file.path.startsWith("src/discord/contracts/"));

      expect(offenders(contracts, /from "discord\.js"/)).toEqual([]);
    });
  });

  describe("RULE 6 — process.env is read only in platform/config", () => {
    it("is not read anywhere else", () => {
      const outside = production.filter((file) => !file.path.startsWith("src/platform/config/"));

      expect(offenders(outside, /process\.env/)).toEqual([]);
    });
  });

  describe("RULE 8 — environment branching lives only in the composition root", () => {
    it("is not decided anywhere else", () => {
      // The rule that makes development mode honest: if a feature could ask
      // which environment it is in, it could take a path production never runs.
      const allowed = ["src/platform/config/", "src/app/wiring.ts"];
      const outside = production.filter(
        (file) => !allowed.some((prefix) => file.path.startsWith(prefix)),
      );

      expect(offenders(outside, /redis\.enabled|isDevelopment|isProduction/)).toEqual([]);
    });

    it("does not read NODE_ENV outside config", () => {
      const outside = production.filter((file) => !file.path.startsWith("src/platform/config/"));

      expect(offenders(outside, /NODE_ENV/)).toEqual([]);
    });
  });

  describe("RULE 2 — domain code depends on nothing", () => {
    it("imports only its own feature and src/shared", () => {
      const domainFiles = production.filter((file) =>
        /^src\/features\/[^/]+\/[^/]+\/domain\//.test(file.path),
      );

      const violations = domainFiles.flatMap((file) => {
        const imports = [...file.text.matchAll(/from "([^"]+)"/g)].map((match) => match[1] ?? "");
        const bad = imports.filter(
          (specifier) => !specifier.startsWith(".") && !specifier.startsWith("#shared/"),
        );
        return bad.map((specifier) => `${file.path} -> ${specifier}`);
      });

      expect(violations).toEqual([]);
    });
  });

  describe("RULE 5 — expected failures are Result values, not throws", () => {
    it("does not throw an expected-failure error from a use case", () => {
      // The rule reads "throw is for programmer error", which leaves plenty of
      // room to argue in the abstract. These particular classes do not: each
      // one models something a caller is meant to handle, and throwing one
      // from a use case is how the compiler stops being able to prove the
      // failure branch was considered.
      //
      // InfrastructureError and InternalError are deliberately absent — those
      // *are* the unexpected kind, and throwing them is correct.
      const expectedFailures = [
        "ValidationError",
        "AuthorizationError",
        "NotFoundError",
        "ConflictError",
        "RateLimitError",
        "DomainError",
      ];

      const useCases = production.filter((file) =>
        /^src\/features\/[^/]+\/[^/]+\/application\//.test(file.path),
      );

      const violations = useCases.flatMap((file) =>
        [...file.text.matchAll(/throw new (\w+)/g)]
          .map((match) => match[1] ?? "")
          .filter((thrown) => expectedFailures.some((name) => thrown.endsWith(name)))
          .map((thrown) => `${file.path} throws ${thrown} — return err(...) instead`),
      );

      expect(violations).toEqual([]);
    });
  });

  describe("failures speak with one voice", () => {
    const errorFiles = production.filter((file) =>
      /^src\/features\/[^/]+\/[^/]+\/domain\/[^/]+\.errors\.ts$/.test(file.path),
    );

    it("has feature error files to check", () => {
      expect(errorFiles.length).toBeGreaterThan(0);
    });

    it("namespaces every error code to its feature", () => {
      // Codes reach logs, metrics labels and support conversations, so they are
      // a public API. `INVALID` from two features is unsearchable;
      // `PREFIX_INVALID` and `WELCOME_INVALID_MESSAGE` are not.
      const wrong = errorFiles.flatMap((file) =>
        [...file.text.matchAll(/code:\s*"([^"]+)"/g)]
          .map((match) => match[1] ?? "")
          .filter((code) => !/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(code))
          .map((code) => `${file.path} declares "${code}" — expected FEATURE_REASON`),
      );

      expect(wrong).toEqual([]);
    });

    it("builds user-facing wording from the shared vocabulary, not inline prose", () => {
      // The drift this prevents is subtle and permanent: "must be 8 characters
      // or fewer" in one feature beside "cannot exceed 8 chars" in another.
      // Both are fine sentences; together they read as two different bots.
      //
      // Checked on the rules files, since that is where a message is chosen.
      // A feature is free to write a genuinely unique sentence — the rule is
      // that a *reusable* phrase has one home, so a rules file that never
      // consults `say` at all is the signal worth catching.
      const ruleFiles = production.filter((file) =>
        /^src\/features\/[^/]+\/[^/]+\/domain\/[^/]+\.(rules|policy|entity)\.ts$/.test(file.path),
      );

      const silent = ruleFiles
        .filter((file) => /new \w*Error\(/.test(file.text))
        .filter((file) => !file.text.includes("say."))
        .map(
          (file) =>
            `${file.path} writes its own failure wording — compose it from #shared/errors/phrasing`,
        );

      expect(silent).toEqual([]);
    });
  });

  describe("nothing is written twice", () => {
    it("has no identical helper duplicated across features", () => {
      // Features are islands, which is right — but it means a useful helper
      // gets copied rather than imported, and the copies then drift. This
      // caught `requireGuild` living identically in two features; it now lives
      // once, beside the policy that guarantees what it narrows.
      //
      // Compares whole function bodies with whitespace normalised, so a
      // reformatted copy is still a copy. Trivial one-liners are ignored —
      // two features both writing `return x.id` is coincidence, not
      // duplication.
      const MIN_MEANINGFUL_LENGTH = 120;

      const bodies = new Map<string, Set<string>>();

      for (const file of production) {
        const feature = /^src\/features\/([^/]+\/[^/]+)\//.exec(file.path)?.[1];
        if (feature === undefined) continue;

        // Top-level function declarations, up to the closing brace in column 0.
        for (const match of file.text.matchAll(/^(?:export )?function [\s\S]*?^}/gm)) {
          const normalised = (match[0] ?? "")
            .replace(/\/\/[^\n]*/g, "")
            .replace(/\s+/g, " ")
            .trim();
          if (normalised.length < MIN_MEANINGFUL_LENGTH) continue;

          bodies.set(normalised, (bodies.get(normalised) ?? new Set()).add(feature));
        }
      }

      const duplicated = [...bodies.entries()]
        .filter(([, features]) => features.size > 1)
        .map(([body, features]) => {
          const name = /function (\w+)/.exec(body)?.[1] ?? "(anonymous)";
          return `${name} is identical in ${[...features].join(" and ")} — give it one home`;
        });

      expect(duplicated).toEqual([]);
    });
  });

  describe("src never imports test doubles", () => {
    it("leaves tests/support to the tests", () => {
      // A fake reachable from production is a fake that will eventually run in
      // production.
      expect(offenders(production, /from "#testing\/|from "[^"]*tests\//)).toEqual([]);
    });
  });

  describe("src holds only shipped code", () => {
    it("contains no test files", () => {
      // The whole reason tests live in tests/: src/ should read as exactly what
      // ships, with nothing else to skip past.
      expect(
        production.filter((file) => file.path.endsWith(".test.ts")).map((f) => f.path),
      ).toEqual([]);
    });

    it("contains no test doubles", () => {
      expect(
        production.filter((file) => /fake|stub|mock/i.test(file.path)).map((f) => f.path),
      ).toEqual([]);
    });

    it("leaves no test orphaned by a moved or deleted source file", () => {
      // The one real cost of separating tests from source is drift: rename a
      // file and its test quietly tests nothing. This is that cost, removed.
      const sourcePaths = new Set(production.map((file) => file.path));

      const orphans = tests
        .filter((file) => file.path.endsWith(".test.ts"))
        .filter(
          (file) =>
            !file.path.startsWith("tests/architecture/") &&
            !file.path.startsWith("tests/support/") &&
            !file.path.startsWith("tests/integration/"),
        )
        .map((file) => ({
          test: file.path,
          expected: `src/${file.path.slice("tests/".length).replace(/\.test\.ts$/, ".ts")}`,
        }))
        .filter((pair) => !sourcePaths.has(pair.expected))
        .map((pair) => `${pair.test} expects ${pair.expected}`);

      expect(orphans).toEqual([]);
    });
  });

  describe("conventions", () => {
    it("uses no banned filenames", () => {
      const banned = new Set([
        "utils.ts",
        "util.ts",
        "helpers.ts",
        "helper.ts",
        "misc.ts",
        "common.ts",
        "index.ts",
        "types.ts",
        "constants.ts",
      ]);

      const found = sources
        .map((file) => file.path)
        .filter((path) => banned.has(path.split("/").pop() ?? ""));

      expect(found).toEqual([]);
    });

    it("names every file in kebab-case", () => {
      const bad = sources
        .map((file) => file.path.split("/").pop() ?? "")
        .filter((name) => !/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9-]+)*\.ts$/.test(name));

      expect(bad).toEqual([]);
    });

    it("puts every feature under a known group", () => {
      // guild / user / bot / owner. A closed vocabulary, because the point of
      // grouping is that the group tells you something — which stops being
      // true the moment anyone can invent one.
      const groups = new Set(["guild", "user", "bot", "owner"]);

      const wrong = production
        .map((file) => /^src\/features\/([^/]+)\//.exec(file.path)?.[1])
        .filter((group): group is string => group !== undefined)
        .filter((group) => !groups.has(group));

      expect([...new Set(wrong)]).toEqual([]);
    });

    it("gives every file in api/ a role the reader recognises", () => {
      // `api/` is where a growing feature sprawls. Left unconstrained it
      // accumulates `ui.ts`, `embeds.ts`, `helpers.ts` — names that say where a
      // file sits rather than what it is, and which therefore become whatever
      // is convenient.
      //
      // The closed list is the fix. A feature with ten screens has ten files
      // and every one of them announces its job: descriptors in `.command.ts`,
      // interaction handlers in `.component.ts` / `.modal.ts`, and everything a
      // user reads in `.presenter.ts`.
      //
      // `.job.ts` belongs here for the same reason `.event.ts` does: a job is a
      // trigger into the application layer, exactly like a command, and putting
      // it anywhere else would split "things that start work" across two
      // directories.
      const roles = ["command", "component", "modal", "event", "job", "presenter"];

      const wrong = production
        .filter((file) => /^src\/features\/[^/]+\/[^/]+\/api\//.test(file.path))
        .map((file) => file.path)
        .filter((path) => {
          const name = path.split("/").pop() ?? "";
          return !roles.some((role) => name.endsWith(`.${role}.ts`));
        });

      expect(wrong).toEqual([]);
    });

    it("keeps user-facing copy out of command files once there is enough to name", () => {
      // A command should read as policy, then use case, then present. When a
      // descriptor starts carrying the strings as well, the file becomes the
      // place three concerns are interleaved — and that is the state it never
      // comes back from.
      //
      // Deliberately a threshold rather than a ban: a one-line reply does not
      // earn a second file, and demanding one would be the kind of rule people
      // route around. Past a handful, it has stopped being incidental.
      const MAX_INLINE_RESPONSES = 4;

      const overloaded = production
        .filter((file) => /\/api\/[^/]+\.command\.ts$/.test(file.path))
        .map((file) => ({
          path: file.path,
          // Counting the literals a Response is built from, not the word.
          responses: [...file.text.matchAll(/kind:\s*"(success|info|warning|list|confirm)"/g)]
            .length,
        }))
        .filter((file) => file.responses > MAX_INLINE_RESPONSES)
        .map(
          (file) =>
            `${file.path} builds ${String(file.responses)} responses — move them to a .presenter.ts`,
        );

      expect(overloaded).toEqual([]);
    });

    it("gives every feature a manifest", () => {
      const featureDirs = new Set(
        production
          .map((file) => /^src\/features\/([^/]+\/[^/]+)\//.exec(file.path)?.[1])
          .filter((name): name is string => name !== undefined),
      );

      const missing = [...featureDirs].filter(
        (name) => !production.some((file) => file.path === `src/features/${name}/feature.ts`),
      );

      expect(missing).toEqual([]);
    });
  });
});
