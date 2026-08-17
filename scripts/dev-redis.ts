import { spawnSync } from "node:child_process";
import { connect } from "node:net";

/**
 * A local Redis for development, when you want one.
 *
 * Redis is optional everywhere — without it the bot caches in-process and locks
 * per-process, which is correct for a single instance. This exists for the two
 * times that is not enough: running more than one instance locally, and
 * exercising the Redis-backed cache and lock before a deploy is the first thing
 * that ever runs them.
 *
 * Unlike `pnpm db:start`, this needs Docker. There is no equivalent of
 * `embedded-postgres` for Redis — no maintained package ships the binaries for
 * every platform, and Redis has no official Windows build at all. Rather than
 * pretend otherwise, this says so plainly and points at the alternative when
 * Docker is missing.
 *
 * The container matches docker-compose.yml exactly — same image, same port,
 * same name — so `docker compose up -d redis` is interchangeable with this and
 * neither leaves a second copy behind.
 *
 *   pnpm redis:start   start it, creating the container on first run
 *   pnpm redis:stop    stop it, removing the container
 *
 * Persistence is off on purpose. A development cache that survives a restart is
 * a cache that can serve a value written by code you have since deleted, and
 * the whole point of the local instance is to test the path, not the data.
 */

const CONTAINER = "bot-redis";
const IMAGE = "redis:7-alpine";
const PORT = 56379;
const URL = `redis://127.0.0.1:${PORT}`;

function docker(...args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

function requireDocker(): void {
  if (docker("version", "--format", "{{.Server.Version}}").ok) return;

  fail(
    "Docker is not available.",
    "Redis ships no cross-platform binaries, so this one needs it.",
    "",
    "Install Docker Desktop, or skip Redis entirely — the bot runs",
    "without it and says so at startup. Leave REDIS_URL blank.",
  );
}

/** Resolves once something is accepting connections, or false at the deadline. */
async function waitForPort(deadlineMs: number): Promise<boolean> {
  const until = Date.now() + deadlineMs;

  while (Date.now() < until) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ port: PORT, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });

    if (open) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return false;
}

function containerState(): "running" | "stopped" | "absent" {
  const { ok, stdout } = docker("inspect", "-f", "{{.State.Running}}", CONTAINER);
  if (!ok) return "absent";
  return stdout === "true" ? "running" : "stopped";
}

async function start(): Promise<void> {
  requireDocker();

  const state = containerState();

  if (state === "running") {
    ready("Redis is already running.");
    return;
  }

  // A stopped container still holds the name, so `docker run` would fail on the
  // collision rather than doing the obvious thing.
  const started =
    state === "stopped"
      ? docker("start", CONTAINER).ok
      : docker(
          "run",
          "--detach",
          "--name",
          CONTAINER,
          "--publish",
          `${PORT}:6379`,
          IMAGE,
          "redis-server",
          "--save",
          "",
          "--appendonly",
          "no",
        ).ok;

  if (!started) {
    fail(
      "Could not start Redis.",
      "The Docker output above says why. A port already in use is the",
      `usual cause — something else may be listening on ${PORT}.`,
    );
  }

  if (!(await waitForPort(15_000))) {
    fail(
      "Redis started but never accepted a connection.",
      `Check it with: docker logs ${CONTAINER}`,
    );
  }

  ready("Redis is running.");
}

function stop(): void {
  requireDocker();

  if (containerState() === "absent") {
    console.log("\nRedis is not running.\n");
    return;
  }

  // Removed rather than merely stopped: persistence is off, so there is no
  // state worth keeping, and a leftover container is one more thing to explain
  // when the next `redis:start` finds the name taken.
  docker("rm", "--force", CONTAINER);
  console.log("\nRedis stopped.\n");
}

function ready(headline: string): void {
  console.log(
    [
      "",
      headline,
      "",
      `  REDIS_URL=${URL}`,
      "",
      "  Put that in .env to use it. Blank it out to go back to",
      "  in-process caching — the bot works either way.",
      "",
    ].join("\n"),
  );
}

function fail(...lines: string[]): never {
  console.error(["", ...lines, ""].join("\n"));
  process.exit(1);
}

const command = process.argv[2];

if (command === "start") {
  await start();
} else if (command === "stop") {
  stop();
} else {
  fail("Usage: pnpm redis:start | pnpm redis:stop");
}
