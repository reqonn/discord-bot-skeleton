import { existsSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";

import { loadConfig } from "#platform/config/config.js";

import { ConfigurationError } from "#shared/errors/app-error.js";

/**
 * Checks the local setup and says what to do next.
 *
 * Exists because "it does not start" has half a dozen causes — no .env, no
 * database, unapplied migrations — and each one produces a different error at a
 * different moment. One command that reports all of them, with the fix beside
 * each, is worth more than a troubleshooting section nobody finds.
 */

interface Check {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly fix?: string;
}

const checks: Check[] = [];

function record(check: Check): void {
  checks.push(check);
}

function checkNode(): void {
  const major = Number(process.versions.node.split(".")[0] ?? "0");
  record({
    label: "Node",
    ok: major >= 22,
    detail: process.version,
    fix: "Install Node 22 or newer (see .nvmrc).",
  });
}

function checkEnvFile(): void {
  const present = existsSync(resolve(process.cwd(), ".env"));
  record({
    label: ".env",
    ok: present,
    detail: present ? "present" : "missing",
    fix: "cp .env.example .env, then fill in DISCORD_TOKEN and DISCORD_CLIENT_ID.",
  });
}

function checkConfig(): ReturnType<typeof loadConfig> | undefined {
  try {
    const config = loadConfig();
    record({ label: "Configuration", ok: true, detail: `valid (${config.env})` });
    return config;
  } catch (error) {
    record({
      label: "Configuration",
      ok: false,
      detail: error instanceof ConfigurationError ? "invalid" : "could not be read",
      fix: error instanceof ConfigurationError ? (error.detail ?? "") : String(error),
    });
    return undefined;
  }
}

async function checkDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const port = Number(parsed.port === "" ? "5432" : parsed.port);

  const reachable = await new Promise<boolean>((settle) => {
    const socket = connect({ host: parsed.hostname, port });
    const finish = (result: boolean): void => {
      socket.destroy();
      settle(result);
    };
    socket.once("connect", () => {
      finish(true);
    });
    socket.once("error", () => {
      finish(false);
    });
    socket.setTimeout(2_000, () => {
      finish(false);
    });
  });

  record({
    label: "PostgreSQL",
    ok: reachable,
    detail: reachable ? `reachable on ${parsed.hostname}:${String(port)}` : "not reachable",
    fix: "pnpm db:start   (or: docker compose up -d postgres)",
  });
}

/**
 * Placeholder values from .env.example.
 *
 * These pass schema validation — they are non-empty strings — so without this
 * check the setup looks healthy and the bot fails much later with
 * "An invalid token was provided", which says nothing about where to look.
 */
const PLACEHOLDERS = new Set(["replace-me", "000000000000000000", "your-token-here", "changeme"]);

function checkDiscordCredentials(
  token: string,
  clientId: string,
  devGuildId: string | undefined,
  guildScoped: boolean,
): void {
  // Real bot tokens are three dot-separated segments and comfortably over 50
  // characters. Anything shorter has not been filled in.
  const tokenLooksReal = !PLACEHOLDERS.has(token) && token.length > 50 && token.includes(".");
  record({
    label: "Discord token",
    ok: tokenLooksReal,
    detail: tokenLooksReal ? "set" : "still a placeholder",
    fix: "Put a real bot token in DISCORD_TOKEN — https://discord.com/developers/applications → your app → Bot → Reset Token.",
  });

  const clientIdSet = !PLACEHOLDERS.has(clientId) && /^\d{17,20}$/.test(clientId);
  record({
    label: "Client ID",
    ok: clientIdSet,
    detail: clientIdSet ? "set" : "still a placeholder",
    fix: "Put your application ID in DISCORD_CLIENT_ID — same page, General Information → Application ID.",
  });

  // Only development deploys guild-scoped, and only then does this matter.
  if (guildScoped) {
    const guildSet = devGuildId !== undefined && /^\d{17,20}$/.test(devGuildId);
    record({
      label: "Dev guild",
      ok: guildSet,
      detail: guildSet ? "set" : "not set",
      fix: "Put your test server's id in DISCORD_DEV_GUILD_ID. Right-click the server in Discord → Copy Server ID (needs Developer Mode enabled in Advanced settings).",
    });
  }
}

function checkRedis(enabled: boolean): void {
  // Not a failure. Development is designed to run without it, and saying so
  // here is what stops people assuming it is required.
  record({
    label: "Redis",
    ok: true,
    detail: enabled
      ? "configured"
      : "not configured — caching is in-process and locking is process-local",
  });
}

async function main(): Promise<void> {
  checkNode();
  checkEnvFile();

  const config = checkConfig();
  if (config !== undefined) {
    checkDiscordCredentials(
      config.discord.token,
      config.discord.clientId,
      config.discord.devGuildId,
      config.profile.commandScope === "guild",
    );
    await checkDatabase(config.database.url);
    checkRedis(config.redis.enabled);
  }

  const width = Math.max(...checks.map((check) => check.label.length));
  console.log("");
  for (const check of checks) {
    console.log(`  ${check.ok ? "✓" : "✗"} ${check.label.padEnd(width)}  ${check.detail}`);
  }

  const failures = checks.filter((check) => !check.ok);
  if (failures.length === 0) {
    // Under `pnpm setup` the caller prints the next step itself.
    console.log(
      process.env["BOT_SETUP"] === "1"
        ? "\n  Everything looks right.\n"
        : "\n  Everything looks right. Next:  pnpm db:migrate && pnpm dev\n",
    );
    return;
  }

  console.log("\n  To fix:\n");
  for (const failure of failures) {
    if (failure.fix !== undefined && failure.fix !== "") {
      console.log(`  ${failure.label}:`);
      for (const line of failure.fix.split("\n")) console.log(`    ${line}`);
      console.log("");
    }
  }

  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`\nDoctor failed: ${String(error)}\n`);
  process.exitCode = 1;
});
