import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every `pnpm <script>` runs something that exists, and runs what it says.
 *
 * A package script is not imported, not typechecked and not linted; it fails
 * the first time somebody types it. In the bot this skeleton was extracted
 * from, a commit that moved `scripts/` left nine of them pointing at files that
 * were no longer there — including the one that deploys commands, found during
 * the deploy.
 */

interface PackageJson {
  readonly scripts: Readonly<Record<string, string>>;
}

async function packageJson(): Promise<PackageJson> {
  const text = await readFile(join(process.cwd(), "package.json"), "utf8");
  return JSON.parse(text) as PackageJson;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(join(process.cwd(), path));
    return true;
  } catch {
    return false;
  }
}

/** Every path a script mentions that looks like a file in this repo. */
function referencedFiles(command: string): readonly string[] {
  return [...command.matchAll(/(?:^|\s)((?:scripts|src|tests)\/[\w./-]+\.(?:ts|mjs|js))/g)]
    .map((match) => match[1])
    .filter((path): path is string => path !== undefined);
}

describe("package scripts", () => {
  it("finds scripts to check", async () => {
    // A guard on the guard: an empty script list would pass vacuously.
    expect(Object.keys((await packageJson()).scripts).length).toBeGreaterThan(10);
  });

  it("runs only files that exist", async () => {
    const { scripts } = await packageJson();
    const broken: string[] = [];

    for (const [name, command] of Object.entries(scripts)) {
      for (const path of referencedFiles(command)) {
        if (!(await exists(path))) broken.push(`${name} -> ${path}`);
      }
    }

    expect(broken, "these package scripts point at files that are not there").toEqual([]);
  });

  /**
   * The entry points a deployment runs. Named individually rather than derived,
   * because the cost of one being absent is a failed deploy rather than a
   * failed command — and the list is short enough to state.
   */
  it("keeps the scripts a deployment depends on", async () => {
    const { scripts } = await packageJson();

    for (const required of ["build", "start", "commands:deploy", "db:migrate", "verify"]) {
      expect(scripts, `package.json must define "${required}"`).toHaveProperty(required);
    }
  });

  /**
   * Scripts pnpm will run *itself* instead of ours.
   *
   * This skeleton had one: `pnpm doctor` ran pnpm's own `doctor`, silently,
   * and the script it was meant to run never started. That reads like a broken
   * machine rather than a shadowed script. It is `check` now, and this keeps
   * the set empty so the next one cannot be added quietly.
   *
   * Remembering to type `pnpm run` is not the fix: the whole failure mode is
   * that nobody remembers.
   */
  it("records every script name pnpm shadows", async () => {
    const { scripts } = await packageJson();

    // pnpm's own subcommands, only the ones a package is at all likely to also
    // define. `setup` is deliberately absent: under pnpm 11 `pnpm setup` was
    // run in this repository and reached scripts/setup.ts, so the builtin does
    // not win there. A name goes on this list when it has been *seen* to be
    // shadowed, not because a subcommand of that name exists.
    const builtins = new Set([
      "add",
      "audit",
      "deploy",
      "dlx",
      "doctor",
      "env",
      "exec",
      "fetch",
      "import",
      "init",
      "install",
      "licenses",
      "link",
      "list",
      "outdated",
      "pack",
      "patch",
      "prune",
      "publish",
      "rebuild",
      "remove",
      "root",
      "server",
      "start",
      "store",
      "test",
      "unlink",
      "update",
      "why",
    ]);

    // `start` and `test` are shadowed *compatibly*: pnpm's builtins for both
    // run the package script of the same name. Only names where the builtin
    // does something else are a trap.
    const compatible = new Set(["start", "test"]);

    const shadowed = Object.keys(scripts)
      .filter((name) => builtins.has(name) && !compatible.has(name))
      .sort();

    expect(shadowed, "rename these — pnpm runs its own command of that name instead").toEqual([]);
  });

  /**
   * The editor setting that stops VS Code disagreeing with `pnpm lint`.
   *
   * Without `typescript.tsdk`, VS Code type-checks with its own bundled
   * compiler rather than the one this project depends on. The typed ESLint
   * rules then cannot resolve anything and report hundreds of errors that are
   * not real, on code that passes `pnpm verify` cleanly. Somebody meeting that
   * concludes the harness is noise.
   */
  it("pins the editor to this project's TypeScript", async () => {
    const text = await readFile(join(process.cwd(), ".vscode/settings.json"), "utf8");

    expect(text).toContain('"typescript.tsdk": "node_modules/typescript/lib"');
  });

  /**
   * The production start script does not read a `.env`.
   *
   * Node's `--env-file-if-exists` prints "not found. Continuing without it."
   * **to stderr** when the file is absent — which is every boot on a platform
   * that supplies the environment itself, and which log viewers paint red. A
   * red line on every deploy that means nothing is how people learn to skim
   * past the ones that mean something.
   *
   * `dev` keeps the flag, because locally the file is the point.
   */
  it("does not make the production start script announce a missing .env", async () => {
    const { scripts } = await packageJson();

    expect(scripts["start"], "start should not read a .env").not.toContain("env-file");

    // The other half: `dev` still does, so this cannot be "fixed" by removing
    // the flag everywhere and quietly breaking local development.
    expect(scripts["dev"]).toContain("env-file-if-exists");
  });
});
