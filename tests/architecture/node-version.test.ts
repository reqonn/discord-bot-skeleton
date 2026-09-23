import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The suite runs on the Node major that the deployment will run.
 *
 * `.nvmrc` is the one of these declarations a machine acts on: CI installs it
 * (`node-version-file: .nvmrc`) and the build image reads it. `engines.node`
 * is a floor rather than a pin — `>=22.0.0` is satisfied by 22, 24 and 26
 * alike — so it cannot catch a mismatch, and did not: this skeleton shipped
 * with `.nvmrc` saying 22, `@types/node` describing 26, and development
 * happening on 24. Every local `pnpm verify` proved the bot worked on a major
 * that no deployment would ever use, against types for a runtime nobody ran.
 *
 * That is worth failing over rather than warning about. The way it breaks is
 * quiet: a newer API is present all through development and simply absent at
 * runtime, so the error arrives in the deployed bot, pointing at a method
 * rather than at the skew that removed it.
 *
 * Major only. Being on 24.19 where CI is on 24.13 is not a finding.
 */

interface PackageJson {
  readonly engines: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

async function read(path: string): Promise<string> {
  return readFile(join(process.cwd(), path), "utf8");
}

/** The major in a specifier, whether it is `24`, `>=24.0.0`, `^24.13.3` or `v24.19.0`. */
function major(specifier: string): string | undefined {
  return /(\d+)/.exec(specifier)?.[1];
}

describe("the Node version", () => {
  it("is the major this process is actually running", async () => {
    const pinned = major((await read(".nvmrc")).trim());
    expect(pinned, ".nvmrc must name a Node major").toBeDefined();

    expect(
      major(process.versions.node),
      `.nvmrc pins Node ${String(pinned)}, but this suite is running on ${process.versions.node} — ` +
        "a green run on another major says nothing about the one that ships",
    ).toBe(pinned);
  });

  it("is the major that engines.node and @types/node name", async () => {
    const pinned = major((await read(".nvmrc")).trim());
    const packageJson = JSON.parse(await read("package.json")) as PackageJson;

    const engines = packageJson.engines["node"] ?? "";
    const types = packageJson.devDependencies["@types/node"] ?? "";

    // Guards on the guard: either field missing would otherwise pass vacuously,
    // because `major("")` is undefined and so is a major nobody declared.
    expect(engines, "package.json must declare engines.node").not.toBe("");
    expect(types, "package.json must depend on @types/node").not.toBe("");

    expect(
      { engines: major(engines), types: major(types) },
      `.nvmrc pins Node ${String(pinned)}, so engines.node and @types/node must name that major ` +
        "too — types that describe a different runtime than the one running is how a cast gets " +
        "written where a fix belonged",
    ).toEqual({ engines: pinned, types: pinned });
  });
});
