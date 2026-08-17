import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createFeatures } from "#app/features.js";
import { buildInfrastructure, type Infrastructure } from "#app/wiring.js";

import { loadConfig } from "#platform/config/config.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import type { CommandDescriptor, OptionSpec } from "#discord/contracts/command.contract.js";
import type { Messenger } from "#discord/contracts/messenger.contract.js";

import { ok } from "#shared/result/result.js";
import { asSnowflake } from "#shared/types/snowflake.types.js";

import { MemoryLogger } from "#testing/memory.logger.js";

/**
 * The words the bot says about itself.
 *
 * Every command description shows up in the same list in Discord's command
 * picker, one under another. Written by six people over two years they read
 * like six different products — "Shows the prefix", "This command will set the
 * welcome message", "configure welcome." — and no reviewer catches the drift,
 * because each one looks fine on its own. Only the list gives it away, and by
 * then nobody is going back to rewrite thirty of them.
 *
 * So the list is checked here, against the real registered commands rather than
 * a grep, in the same pass that runs the type checker.
 *
 * **The rules, in one line each.**
 *
 * A *command* description is an imperative sentence: "Set the message new
 * members are greeted with". It starts with a verb from {@link VERBS} — adding
 * one is a deliberate edit to this file, which is the whole point — so "Shows",
 * "Setting" and "Configure the welcome" are all rejected by construction.
 *
 * An *option* description is a noun phrase naming the value: "The channel new
 * members are greeted in". It must **not** start with a command verb, because
 * an option is a thing you supply, not an action you take, and "Set the
 * channel" on the parameter of a command already called "Set where the greeting
 * is posted" says the same thing twice.
 *
 * Neither ends in a full stop, mentions "this command", or repeats the name of
 * the command it belongs to.
 */

/**
 * The verbs a command description may open with.
 *
 * Curated, not exhaustive. A short list is what makes the vocabulary uniform:
 * "Show" and "View" and "Display" are three words for one idea, and picking one
 * is the difference between a coherent command list and a thesaurus. Add a verb
 * when a genuinely new *kind* of action arrives, not when one reads slightly
 * better in a single case.
 */
const VERBS = [
  "Add",
  "Ban",
  "Cancel",
  "Change",
  "Check",
  "Choose",
  "Clear",
  "Close",
  "Create",
  "Delete",
  "Disable",
  "Edit",
  "Enable",
  "Kick",
  "List",
  "Lock",
  "Mute",
  "Open",
  "Pin",
  "Post",
  "Remove",
  "Rename",
  "Reset",
  "Search",
  "Send",
  "Set",
  "Show",
  "Start",
  "Stop",
  "Timeout",
  "Unban",
  "Unlock",
  "Unmute",
  "Warn",
] as const;

/** Discord's own cap. Exceeding it is rejected at deploy, not at runtime. */
const MAX_DESCRIPTION = 100;

/**
 * Phrases that describe the mechanism rather than the effect.
 *
 * "This command shows the prefix" spends four words telling the reader they are
 * looking at a command, which they can see.
 */
const PADDING = [/\bthis command\b/i, /\bthis option\b/i, /\buse this\b/i, /\ballows you to\b/i];

/** Never called: building a feature does not send anything. */
const messenger: Messenger = {
  send: () => Promise.resolve(ok(asSnowflake("1"))),
  edit: () => Promise.resolve(ok(null)),
};

/**
 * The real command list, built the way the bot builds it.
 *
 * A pool is lazy — nothing connects until a query runs, and none is run here —
 * so this constructs every feature without a database. Reading the descriptors
 * rather than grepping the source is what makes the check exact: it sees what
 * Discord will be sent.
 */
let infrastructure: Infrastructure | undefined;

function allCommands(): CommandDescriptor[] {
  infrastructure ??= buildInfrastructure(
    loadConfig({
      DISCORD_TOKEN: "token",
      DISCORD_CLIENT_ID: "1",
      DATABASE_URL: "postgres://bot:bot@127.0.0.1:55432/bot",
    }),
    new MemoryLogger(),
    new MetricsRegistry(),
  );

  return createFeatures(infrastructure, "!", new MemoryLogger(), messenger).flatMap(
    (feature) => feature.commands ?? [],
  );
}

afterAll(async () => {
  await infrastructure?.stop();
});

const commands = allCommands();
const options: { command: CommandDescriptor; option: OptionSpec }[] = commands.flatMap((command) =>
  command.options.map((option) => ({ command, option })),
);

describe("command descriptions", () => {
  it("there are some, so the checks below mean something", () => {
    // A registry that silently returned nothing would make every test here
    // pass by vacuum, which is the failure mode of a harness like this.
    expect(commands.length).toBeGreaterThan(5);
  });

  it.each(commands.map((command) => [command.name, command.description] as const))(
    "/%s opens with an approved verb",
    (name, description) => {
      const first = description.split(" ")[0] ?? "";

      expect(
        VERBS.includes(first as (typeof VERBS)[number]),
        `/${name}: "${description}" opens with "${first}". A command description is an imperative sentence — start it with one of: ${VERBS.join(", ")}. Adding a verb to that list is a deliberate edit to tests/architecture/wording.test.ts.`,
      ).toBe(true);
    },
  );

  it.each(commands.map((command) => [command.name, command.description] as const))(
    "/%s reads as one plain sentence",
    (name, description) => {
      expect(description.endsWith("."), `/${name}: drop the full stop.`).toBe(false);
      expect(
        description.length,
        `/${name}: Discord allows ${String(MAX_DESCRIPTION)} characters.`,
      ).toBeLessThanOrEqual(MAX_DESCRIPTION);

      for (const phrase of PADDING) {
        expect(
          phrase.test(description),
          `/${name}: "${description}" is padded — say the effect.`,
        ).toBe(false);
      }
    },
  );

  it.each(commands.map((command) => [command.name, command.description] as const))(
    "/%s does not repeat its own name",
    (name, description) => {
      // "welcome — Show the welcome message" reads as a stutter in the picker,
      // where the name is already on the line above.
      const noun = name.split(" ").at(-1) ?? "";
      const words = description.toLowerCase().split(/[^a-z]+/);

      expect(
        words.slice(0, 2).includes(noun),
        `/${name}: "${description}" opens by repeating "${noun}", which Discord already shows.`,
      ).toBe(false);
    },
  );

  it("no two commands describe themselves the same way", () => {
    // Two identical descriptions means at least one of them is describing the
    // other command, and the picker gives the reader no way to choose.
    const seen = new Map<string, string>();

    for (const command of commands) {
      const clash = seen.get(command.description);
      expect(clash, `/${command.name} and /${clash ?? ""} share a description.`).toBeUndefined();
      seen.set(command.description, command.name);
    }
  });
});

describe("option descriptions", () => {
  it.each(options.map(({ command, option }) => [command.name, option.name, option.description]))(
    "/%s %s names the value rather than the action",
    (name, optionName, description) => {
      const first = description.split(" ")[0] ?? "";

      expect(
        VERBS.includes(first as (typeof VERBS)[number]),
        `/${name} (${optionName}): "${description}" opens with the verb "${first}". An option is a value you supply, not an action — name the thing, as in "The channel new members are greeted in".`,
      ).toBe(false);
    },
  );

  it.each(options.map(({ command, option }) => [command.name, option.name, option.description]))(
    "/%s %s is a short, capitalised phrase",
    (name, optionName, description) => {
      const label = `/${name} (${optionName})`;

      expect(description.length, `${label}: must not be empty.`).toBeGreaterThan(0);
      expect(
        description.length,
        `${label}: Discord allows ${String(MAX_DESCRIPTION)} characters.`,
      ).toBeLessThanOrEqual(MAX_DESCRIPTION);
      expect(description.endsWith("."), `${label}: drop the trailing full stop.`).toBe(false);
      expect(
        /^[A-Z"]/.test(description),
        `${label}: "${description}" should start with a capital.`,
      ).toBe(true);

      for (const phrase of PADDING) {
        expect(phrase.test(description), `${label}: "${description}" is padded.`).toBe(false);
      }
    },
  );
});

/**
 * The sentences presenters hand back.
 *
 * A command description is checked above by reading the descriptor; a
 * presenter's copy cannot be, because most of it is built at runtime from ids
 * and names. What *can* be checked is the literal text in the source, and that
 * is where the drift starts: one reply written as a fragment, the next as a
 * headline, and six months later the bot has three voices.
 *
 * The rule is the one the response shape already implies — an outcome is one
 * sentence — so this only has to hold the ends of it: a capital at the front, a
 * full stop at the back.
 */
describe("presenter copy", () => {
  const presenters = readPresenters();

  it("there are some, so the checks below mean something", () => {
    expect(presenters.length).toBeGreaterThan(0);
  });

  it.each(presenters)("%s writes whole sentences", (_name, source) => {
    // Only literal, non-interpolated strings: a template is assembled at
    // runtime and its ends are not knowable here.
    for (const [, sentence] of source.matchAll(/^\s*text:\s*"([^"]+)",$/gm)) {
      const text = sentence ?? "";

      expect(/^[A-Z]/.test(text), `"${text}" should start with a capital.`).toBe(true);
      expect(/[.!?]$/.test(text), `"${text}" should end in a full stop.`).toBe(true);
    }
  });
});

function readPresenters(): [string, string][] {
  const found: [string, string][] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".presenter.ts")) {
        found.push([entry.name, readFileSync(full, "utf8")]);
      }
    }
  }

  walk(resolve(process.cwd(), "src/features"));
  return found;
}

/**
 * The sentences a failure is built from.
 *
 * A domain error's `userMessage` is shown to a user verbatim, and it is the
 * easiest copy in the codebase to get wrong: the constructor takes a string, so
 * a fragment written to be appended to something — `"set a message and a
 * channel"` — compiles, passes every other check, and ships as
 * `⛔ set a message and a channel`.
 *
 * So a literal handed to an error must be a whole sentence, exactly as a
 * presenter's is. Anything reusable belongs in `#shared/errors/phrasing` and
 * arrives here as `say.something(…)`, which this rule ignores.
 */
describe("failure copy", () => {
  const sources = readFeatureSources();

  it("there are some, so the check below means something", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  it.each(sources)("%s hands errors whole sentences", (_name, source) => {
    // A string or template literal as the first argument to an Error.
    for (const [, sentence] of source.matchAll(/new \w*Error\(\s*["'`]([^"'`]*)["'`]/g)) {
      const text = sentence ?? "";

      expect(
        /^[A-Z*`]/.test(text),
        `"${text}" should start with a capital, or come from say.*`,
      ).toBe(true);
      expect(/[.!?]$/.test(text), `"${text}" should end in a full stop.`).toBe(true);
    }
  });
});

function readFeatureSources(): [string, string][] {
  const found: [string, string][] = [];

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) found.push([entry.name, readFileSync(full, "utf8")]);
    }
  }

  walk(resolve(process.cwd(), "src/features"));
  return found;
}
