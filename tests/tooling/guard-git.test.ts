import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

/**
 * The hook that refuses to stage the whole tree.
 *
 * A working tree is often shared — by a second agent session, or a person with
 * a half-finished edit — so `git add -A` stages their work and commits it under
 * this commit's message. A single regex against the raw command was narrower
 * and wider than it looked:
 *
 * - `git add -u`, `git add :/`, `git -C . add -A` and `git commit -am` all
 *   staged everything and went straight through;
 * - a read-only `grep` whose *pattern* contained `git add -A` was blocked;
 * - a commit message in a heredoc that merely mentioned it would have been.
 *
 * It reads a command the way a shell does now — segments, quotes, heredocs —
 * and judges each `git` invocation on its own arguments.
 */

function verdictFor(command: string): "blocked" | "allowed" {
  const run = spawnSync("node", [".claude/hooks/guard-git.mjs"], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: "utf8",
  });

  return run.status === 2 ? "blocked" : "allowed";
}

describe("staging everything", () => {
  it.each([
    "git add -A",
    "git add --all",
    "git add .",
    "git add -u",
    "git add --update",
    "git add :/",
    "git add '*'",
    "git -C . add -A",
    'git -C "/home/someone/projects/a bot" add -A',
    "npm test && git add -A",
    "(git add -A)",
    'git commit -am "message"',
    "git commit -a -m message",
    "git commit --all -m message",
  ])("blocks %s", (command) => {
    expect(verdictFor(command)).toBe("blocked");
  });
});

describe("staging by name, and everything that only mentions it", () => {
  it.each([
    "git add src/app/features.ts tests/app/features.test.ts",
    'git commit -m "stage by name, never git add -A"',
    "grep -n 'git add -A' AGENTS.md",
    "git status --short && git diff --stat",
    "git commit -q -F - <<'EOF'\nfix: explain why git add -A is refused\n\nNever git add .\nEOF",
    "$msg = @'\nnever git add -A here\n'@\ngit commit -q -F commit.txt",
    "echo git add -A",
  ])("allows %s", (command) => {
    expect(verdictFor(command)).toBe("allowed");
  });
});

describe("when it cannot read the command", () => {
  it("fails open rather than blocking work it does not understand", () => {
    const run = spawnSync("node", [".claude/hooks/guard-git.mjs"], {
      input: "this is not json",
      encoding: "utf8",
    });

    expect(run.status).toBe(0);
  });
});
