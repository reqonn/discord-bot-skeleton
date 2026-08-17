import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Scaffolds a feature directory.
 *
 * Deliberately minimal: a manifest and one command, and nothing else.
 * `application/`, `domain/` and `infrastructure/` appear when there is a use
 * case to write, a rule to protect, or state to store — generating them empty
 * "for consistency" teaches the opposite of what the layering is for, and
 * produces features with an anaemic domain folder nobody ever removes.
 *
 * What it emits must pass `pnpm verify` unmodified. A scaffolder whose output
 * fails the project's own checks teaches a new contributor, on their first
 * command, that the checks are noise to be worked around.
 */

/**
 * The group vocabulary, closed on purpose.
 *
 * The point of grouping is that the group tells you something — which stops
 * being true the moment anyone can invent one. An architecture test enforces
 * this same list.
 */
const GROUPS: Record<string, string> = {
  guild: "operates on a server: settings, tickets, moderation, welcome",
  user: "scoped to a person wherever they are: profile, reminders, fun",
  bot: "about the bot itself, usable anywhere: ping, help, info",
  owner: "bot-owner only: diagnostics, administration",
};

const [group, name] = process.argv.slice(2);

function usage(problem: string): never {
  console.error(`\n${problem}\n`);
  console.error("Usage: pnpm new:feature <group> <kebab-case-name>\n");
  for (const [key, description] of Object.entries(GROUPS)) {
    console.error(`  ${key.padEnd(6)} ${description}`);
  }
  console.error("\nExample: pnpm new:feature guild reminders\n");
  process.exit(1);
}

if (group === undefined || !(group in GROUPS)) {
  usage(`Unknown group ${group === undefined ? "(missing)" : `"${group}"`}.`);
}
if (name === undefined || !/^[a-z][a-z0-9-]*$/.test(name)) {
  usage(
    `Feature name must be kebab-case; received ${name === undefined ? "(missing)" : `"${name}"`}.`,
  );
}

const root = resolve(process.cwd(), "src", "features", group, name);

if (existsSync(root)) {
  console.error(`\nsrc/features/${group}/${name} already exists.\n`);
  process.exit(1);
}

/** `reminders` -> `Reminders`, for type and factory names. */
const pascal = name
  .split("-")
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join("");

const files: Record<string, string> = {
  "feature.ts": `import { defineFeature, type Feature } from "#app/feature.contract.js";

import { create${pascal}Command } from "./api/${name}.command.js";

/**
 * This feature needs nothing yet. When it does, declare exactly what:
 *
 *   export interface ${pascal}Deps {
 *     readonly database: Database;
 *   }
 *
 *   export function create${pascal}Feature(deps: ${pascal}Deps): Feature {
 *
 * and pass them from src/app/features.ts. Listing them in one interface is what
 * makes a feature's dependencies readable without opening its source.
 */
export function create${pascal}Feature(): Feature {
  return defineFeature({
    id: "${name}",
    commands: [create${pascal}Command()],
  });
}
`,

  [`api/${name}.command.ts`]: `import { z } from "zod";

import { inGuild } from "#discord/contracts/authorization.contract.js";
import { defineCommand } from "#discord/contracts/command.contract.js";
import type { Response } from "#discord/contracts/response.contract.js";

/**
 * Declare policy, call a use case, map the result to a Response.
 *
 * No business rules here and no rendering: the pipeline enforces the first,
 * src/discord/ui owns the second.
 */
export function create${pascal}Command() {
  return defineCommand({
    name: "${name}",
    description: "TODO: describe what this does",
    input: z.object({}),
    // Every command declares who may run it. "Anyone" is openToEveryone().
    authorize: [inGuild()],
    handle: (): Promise<Response> =>
      Promise.resolve({ kind: "info", title: "Not implemented yet" }),
  });
}
`,
};

async function main(): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents, "utf8");
  }

  console.log(
    [
      "",
      `Created src/features/${group}/${name}/`,
      "",
      "It passes `pnpm verify` as generated. Next:",
      "",
      "  1. Add it to src/app/features.ts:",
      `       create${pascal}Feature(),`,
      "  2. pnpm commands:deploy && pnpm dev — the command already answers",
      "  3. Move the work into application/ as a use case",
      "  4. Add domain/ when there is a rule to protect",
      "  5. Add infrastructure/ when there is state to store",
      "",
      "  docs/architecture.md § 6 has the recipes.",
      "",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(`\nCould not scaffold the feature: ${String(error)}\n`);
  process.exit(1);
});
