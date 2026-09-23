/**
 * Refuses to end a turn on code that does not compile.
 *
 * The cheapest part of `pnpm verify` — a few seconds — run automatically so
 * that "done" always means at least "it builds". The rest of the gate (lint,
 * format, depcruise, tests) is still the agent's to run before saying a change
 * is finished; this is the floor, not the standard.
 *
 * Only when something actually changed, so a conversational turn costs nothing.
 *
 * Fails open on everything except a real type error: if `git` or `tsc` cannot
 * be run at all, the turn ends normally. A hook that blocks work whenever the
 * environment surprises it gets switched off, and then it guards nothing.
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function run(command, args) {
  return execFileSync(command, args, {
    cwd: repository,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  // Already blocked once this turn. Without this the hook can hold a session
  // in a loop against an error it cannot fix.
  try {
    if (JSON.parse(input)?.stop_hook_active === true) process.exit(0);
  } catch {
    process.exit(0);
  }

  let dirty = "";
  try {
    dirty = run("git", ["status", "--porcelain"]).trim();
  } catch {
    process.exit(0);
  }
  if (dirty === "") process.exit(0);

  try {
    run("npx", ["tsc", "--noEmit"]);
  } catch (error) {
    const said = `${error?.stdout ?? ""}${error?.stderr ?? ""}`.trim();
    // An empty message means tsc never ran — a missing binary, a broken PATH.
    // That is not a type error and must not hold the turn.
    if (said === "") process.exit(0);

    process.stderr.write(
      `The working tree does not typecheck, so this turn is not finished:\n\n${said}\n\n` +
        "Fix it, then run `pnpm verify` for the rest of the gate.\n",
    );
    process.exit(2);
  }

  process.exit(0);
});
