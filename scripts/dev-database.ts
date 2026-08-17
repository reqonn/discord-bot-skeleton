import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { join, resolve } from "node:path";

import pg from "pg";

/**
 * A local PostgreSQL for development, without Docker.
 *
 * Docker is the documented path and `docker compose up -d postgres` works
 * identically — but requiring it in order to run the bot at all is a real
 * barrier, and "install Docker Desktop" is a poor first step in a contributing
 * guide. This runs a real PostgreSQL out of .devdb/ using the binaries that
 * ship with the `embedded-postgres` dev dependency.
 *
 * It drives `pg_ctl` rather than the library's JavaScript API because pg_ctl
 * daemonises: the server outlives this process, so you get your shell back.
 * The library's own `start()` ties the server's lifetime to the caller, which
 * makes `pnpm db:start` useless as a one-shot command.
 *
 * Both paths listen on 55432 with the same credentials, so DATABASE_URL is
 * identical either way and nothing downstream knows which is running.
 *
 *   pnpm db:start      start, creating the cluster on first run
 *   pnpm db:stop    stop, keeping the data
 *   pnpm db:reset   delete the cluster and start fresh
 */

const DATA_DIR = resolve(process.cwd(), ".devdb", "data");
const LOG_FILE = resolve(process.cwd(), ".devdb", "server.log");
const PORT = "55432";
const USER = "bot";
const DATABASE = "bot";

/** The platform-specific package that carries the PostgreSQL binaries. */
const PLATFORM_PACKAGES: Record<string, string> = {
  "win32-x64": "@embedded-postgres/windows-x64",
  "linux-x64": "@embedded-postgres/linux-x64",
  "linux-arm64": "@embedded-postgres/linux-arm64",
  "darwin-x64": "@embedded-postgres/darwin-x64",
  "darwin-arm64": "@embedded-postgres/darwin-arm64",
};

function binDirectory(): string {
  const key = `${process.platform}-${process.arch}`;
  const packageName = PLATFORM_PACKAGES[key];
  if (packageName === undefined) {
    fail(`No bundled PostgreSQL for ${key}.`, "Use Docker instead: docker compose up -d postgres");
  }

  // The platform package is an optional dependency of embedded-postgres, not of
  // this project, so it is resolved relative to that package rather than to us.
  // Both packages export only their entry point, so the package root is reached
  // from the resolved entry file rather than from package.json.
  const fromHere = createRequire(import.meta.url);

  try {
    const host = fromHere.resolve("embedded-postgres");
    const entry = createRequire(host).resolve(packageName);
    return join(entry, "..", "..", "native", "bin");
  } catch (error) {
    return fail(
      `Could not locate the PostgreSQL binaries in ${packageName}.`,
      [
        error instanceof Error ? error.message : String(error),
        "",
        "Run `pnpm install`, then `pnpm approve-builds` if pnpm reports an ignored build script.",
      ].join("\n"),
    );
  }
}

function run(executable: string, args: readonly string[]): { ok: boolean; output: string } {
  const result = spawnSync(join(binDirectory(), executable), args, {
    encoding: "utf8",
    env: { ...process.env, PGDATA: DATA_DIR },
  });

  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

/**
 * Starts the server detached.
 *
 * stdio is discarded rather than captured, and `-w` is not used. A captured
 * pipe is inherited by the daemonised postmaster, which then holds it open for
 * its whole lifetime — so a waiting parent never sees EOF and hangs forever,
 * even though the server started perfectly. Readiness is confirmed by polling
 * the port instead, which is what we actually care about.
 */
function startDetached(): void {
  spawnSync(
    join(binDirectory(), "pg_ctl"),
    ["-D", DATA_DIR, "-l", LOG_FILE, "-o", `-p ${PORT} -c listen_addresses=127.0.0.1`, "start"],
    { stdio: "ignore", env: { ...process.env, PGDATA: DATA_DIR } },
  );
}

function isRunning(): boolean {
  return run("pg_ctl", ["-D", DATA_DIR, "status"]).ok;
}

/**
 * Creates the application database if it is missing.
 *
 * Done over a SQL connection rather than with `createdb` because the bundled
 * distribution ships only the server binaries — initdb, pg_ctl, and postgres.
 * Using `pg`, which is already a dependency, also makes this idempotent, so
 * `pnpm db:start` repairs a cluster whose database was dropped.
 */
async function ensureDatabase(): Promise<void> {
  const client = new pg.Client({
    host: "127.0.0.1",
    port: Number(PORT),
    user: USER,
    database: "postgres",
  });

  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [DATABASE]);
    if (existing.rowCount === 0) {
      // CREATE DATABASE takes no parameters and cannot run in a transaction.
      // DATABASE is a compile-time constant, so there is nothing to inject.
      await client.query(`CREATE DATABASE ${DATABASE}`);
      console.log(`Created database "${DATABASE}".`);
    }
  } finally {
    await client.end();
  }
}

/** Resolves once the server accepts a TCP connection, or false at the deadline. */
async function waitUntilAccepting(timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolveConnected) => {
      const socket = connect({ port: Number(PORT), host: "127.0.0.1" });
      const settle = (result: boolean): void => {
        socket.destroy();
        resolveConnected(result);
      };
      socket.once("connect", () => {
        settle(true);
      });
      socket.once("error", () => {
        settle(false);
      });
      socket.setTimeout(1_000, () => {
        settle(false);
      });
    });

    if (connected) return true;
    await new Promise((sleep) => setTimeout(sleep, 250));
  }

  return false;
}

async function up(): Promise<void> {
  await mkdir(resolve(process.cwd(), ".devdb"), { recursive: true });

  const firstRun = !existsSync(join(DATA_DIR, "PG_VERSION"));
  if (firstRun) {
    console.log("Creating a PostgreSQL cluster in .devdb/ (first run only)...");
    const init = run("initdb", [
      "-D",
      DATA_DIR,
      "-U",
      USER,
      // Trust auth on a loopback-only development cluster. The password in
      // DATABASE_URL is accepted and ignored, so both setups share one URL.
      "--auth=trust",
      "--encoding=UTF8",
      "--locale=C",
    ]);
    if (!init.ok) fail("initdb failed.", init.output);
  }

  if (isRunning()) {
    console.log(`PostgreSQL is already running on port ${PORT}.`);
  } else {
    startDetached();
    if (!(await waitUntilAccepting())) {
      fail("PostgreSQL did not start accepting connections.", `See ${LOG_FILE}`);
    }
  }

  // Runs whether or not we just started the server, so `pnpm db:start` also
  // repairs a cluster whose database was dropped.
  await ensureDatabase();

  console.log(
    [
      "",
      `PostgreSQL is running on port ${PORT}.`,
      "",
      `  DATABASE_URL=postgres://${USER}:${USER}@127.0.0.1:${PORT}/${DATABASE}`,
      "",
      // Suppressed under `pnpm setup`, which prints its own next step — three
      // different suggestions in one run is how a quick start stops being one.
      ...(process.env["BOT_SETUP"] === "1" ? [] : ["Next:  pnpm db:migrate  &&  pnpm dev", ""]),
    ].join("\n"),
  );
}

async function down(): Promise<void> {
  if (!isRunning()) {
    console.log("PostgreSQL is not running.");
    return;
  }

  // Fast shutdown: disconnect clients and roll back, rather than waiting for
  // sessions to end on their own.
  const stop = run("pg_ctl", ["-D", DATA_DIR, "-m", "fast", "-w", "stop"]);
  if (!stop.ok) fail("Could not stop PostgreSQL.", stop.output);

  console.log("PostgreSQL stopped. Data in .devdb/ is preserved.");
  return Promise.resolve();
}

async function reset(): Promise<void> {
  if (isRunning()) await down();
  await rm(resolve(process.cwd(), ".devdb"), { recursive: true, force: true });
  console.log("Deleted .devdb/. Creating a fresh cluster...\n");
  await up();
}

async function status(): Promise<void> {
  console.log(
    isRunning() ? `Running on port ${PORT}.` : "Not running. Start it with: pnpm db:start",
  );
  return Promise.resolve();
}

function fail(message: string, detail?: string): never {
  console.error(`\n${message}`);
  if (detail !== undefined && detail !== "") console.error(`\n${detail}`);
  console.error("");
  process.exit(1);
}

// `up`/`down` are kept as aliases of `start`/`stop`: they are what the Docker
// muscle memory reaches for, and rejecting them teaches nothing.
const COMMANDS: Record<string, () => Promise<void>> = {
  start: up,
  stop: down,
  up,
  down,
  reset,
  status,
};

const command = process.argv[2] ?? "start";
const selected = COMMANDS[command];

if (selected === undefined) {
  fail(`Unknown command "${command}". Expected one of: ${Object.keys(COMMANDS).join(", ")}`);
}

selected().catch((error: unknown) => {
  fail(
    `Failed to ${command} the development database.`,
    error instanceof Error ? error.message : String(error),
  );
});
