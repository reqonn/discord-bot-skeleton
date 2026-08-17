import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Stops everything this project starts: the bot, and the local database.
 *
 * The bot is supposed to stop on its own when its terminal closes — `main.ts`
 * handles SIGHUP and watches stdin for exactly that. Windows does not make that
 * promise reliably: nothing cascades down a process tree, and whether a closing
 * terminal delivers a console event depends on the terminal. `pnpm dev` runs the
 * bot three processes below the shell, so when it does go wrong the result is an
 * invisible bot holding a gateway connection with no window left to stop it in.
 *
 * This is the escape hatch that does not depend on any of that.
 *
 * On Windows the kill is not graceful — the platform has no real SIGTERM, and
 * Node's `process.kill` becomes a TerminateProcess. Acceptable here: PostgreSQL
 * reclaims dropped connections on its own and Discord reconnects, so the cost is
 * a shutdown sequence that does not get to log. Do not reach for this in
 * production, where SIGTERM is real and the ordered shutdown matters.
 */

const ROOT = resolve(process.cwd());

interface Found {
  readonly pid: number;
  readonly command: string;
}

/**
 * Node processes running *this* project's entry point.
 *
 * Matched on the entry path rather than on "node", so another project's bot in
 * another window is never touched. Catches both `tsx watch` and the child it
 * supervises — killing only the child would have the watcher restart it.
 */
function findBotProcesses(): Found[] {
  const marker = /main\.(ts|js)/;

  if (process.platform === "win32") {
    const script =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }';
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8" },
    );
    return parse(output, marker);
  }

  const output = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  return parse(output.replace(/^\s*(\d+)\s+/gm, "$1\t"), marker);
}

function parse(output: string, marker: RegExp): Found[] {
  const found: Found[] = [];

  for (const line of output.split("\n")) {
    const [rawPid, ...rest] = line.trim().split("\t");
    const command = rest.join("\t");
    const pid = Number(rawPid);

    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    // Both conditions matter: the entry point says it is a bot, and the path
    // says it is *this* checkout.
    if (!marker.test(command)) continue;
    if (!command.includes(ROOT) && !command.includes(ROOT.replace(/\\/g, "/"))) continue;

    found.push({ pid, command });
  }

  return found;
}

function stopBot(): number {
  let processes: Found[];
  try {
    processes = findBotProcesses();
  } catch (error) {
    console.log(`  Could not inspect running processes: ${String(error)}`);
    return 0;
  }

  if (processes.length === 0) {
    console.log("  No bot process running.");
    return 0;
  }

  let stopped = 0;
  for (const { pid } of processes) {
    try {
      process.kill(pid, "SIGTERM");
      stopped += 1;
      console.log(`  Stopped process ${String(pid)}.`);
    } catch {
      // Already gone — killing a supervisor often takes its child with it, and
      // the child may be later in this same list.
    }
  }

  return stopped;
}

console.log("\nStopping the bot.");
stopBot();

console.log("\nStopping PostgreSQL.");
const database = spawnSync("pnpm run db:stop", { stdio: "inherit", shell: true });

console.log(
  [
    "",
    "─".repeat(60),
    database.status === 0
      ? "Everything stopped. `pnpm dev` starts the bot again; the database"
      : "Bot stopped. PostgreSQL reported a problem above; the database",
    "keeps its data, so nothing was lost.",
    "",
  ].join("\n"),
);
