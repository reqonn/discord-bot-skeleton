import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Everything between `git clone` and a running bot, in one command.
 *
 * The steps underneath are still separate scripts — `db:start`, `db:migrate`,
 * `check` — because each is independently useful once you know the project.
 * This exists because nobody knows the project on their first day, and a
 * seven-line quick start is seven chances to stop.
 *
 * Order matters: `check` runs *before* migrations, because every script that
 * touches the database also loads the full config, and the full config wants a
 * Discord token. On a first run there isn't one yet, so migrating first fails
 * with "DISCORD_TOKEN is required" — a true statement about a completely
 * unrelated step. Diagnosing before acting means the first run ends with the
 * three values to go and fill in, which is the actual state of things.
 */

const ENV_FILE = resolve(process.cwd(), ".env");
const ENV_EXAMPLE = resolve(process.cwd(), ".env.example");

const RULE = "─".repeat(60);

function step(number: number, what: string): void {
  console.log(`\n[${String(number)}/4] ${what}`);
}

/**
 * Runs a package script, streaming its output. Returns whether it succeeded.
 *
 * The whole command goes in as one string rather than a name plus an args array
 * — with `shell: true` the array form is deprecated (DEP0190), and every script
 * name here is a literal below, so there is nothing to escape.
 *
 * BOT_SETUP tells those scripts to leave off their own "Next:" hints; this
 * script prints the one that is actually next.
 */
function run(script: string): boolean {
  const result = spawnSync(`pnpm run ${script}`, {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, BOT_SETUP: "1" },
  });
  return result.status === 0;
}

function say(...lines: string[]): void {
  console.log(["", RULE, ...lines, ""].join("\n"));
}

async function main(): Promise<void> {
  console.log("Setting up the Discord bot skeleton.");

  // ── 1. Configuration ───────────────────────────────────────────────────────
  step(1, "Configuration");
  if (existsSync(ENV_FILE)) {
    console.log("  .env already exists — leaving it alone.");
  } else {
    await copyFile(ENV_EXAMPLE, ENV_FILE);
    console.log("  Created .env from .env.example.");
  }

  // ── 2. Database ────────────────────────────────────────────────────────────
  // Safe before the config is complete: this script talks to PostgreSQL
  // directly and never loads the bot's configuration.
  step(2, "Database");
  if (!run("db:start")) {
    say("Could not start PostgreSQL. The output above says why.");
    process.exit(1);
  }

  // ── 3. What is still missing ───────────────────────────────────────────────
  step(3, "Checking your setup");
  if (!run("check")) {
    say(
      "Not ready yet — fill in the values listed above in .env,",
      "then run this again:",
      "",
      "  pnpm setup",
    );
    return; // Not a failure. A first run is expected to land here.
  }

  // ── 4. Migrations ──────────────────────────────────────────────────────────
  step(4, "Migrations");
  if (!run("db:migrate")) {
    say("Could not apply migrations. The output above says why.");
    process.exit(1);
  }

  say(
    "Ready. Two commands from here:",
    "",
    "  pnpm commands:deploy    register /ping with Discord (once)",
    "  pnpm dev                run the bot",
    "",
    "Then type /ping in your test server.",
    "",
    "PostgreSQL is now running in the background and stays running, the",
    "same way `docker compose up -d` would. Stop it with `pnpm db:stop`.",
  );
}

main().catch((error: unknown) => {
  console.error(`\nSetup failed: ${String(error)}\n`);
  process.exit(1);
});
