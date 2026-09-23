/**
 * Refuses to stage the whole tree, however it is spelled.
 *
 * A working tree is often shared — by a second agent session, or by a person
 * with a half-finished edit open. Staging everything stages their work too and
 * commits it under this commit's message. Stage the paths you touched, by name.
 *
 * A single regex against the raw command was narrower and wider than it
 * looked: `git add -u`, `git add :/`, `git -C . add -A` and `git commit -am`
 * went straight through, while a `grep` whose *pattern* said `git add -A` was
 * blocked. So this reads the command the way a shell does — segments, quotes,
 * heredocs — and judges each `git` invocation on its own arguments. Wired to
 * both the Bash and the PowerShell tool.
 *
 * Fails open: anything unexpected — a schema that changed, a command it cannot
 * read — exits 0 and lets the tool run. A guard that blocks work it does not
 * understand is worse than no guard.
 */

/** `git add` arguments that mean "everything". */
const ADD_EVERYTHING = new Set([
  ".",
  ":/",
  ":",
  "*",
  "-A",
  "--all",
  "-u",
  "--update",
  "--no-ignore-removal",
]);

/** Options that take the next word as their value, before and after the subcommand. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
const COMMIT_VALUE_OPTIONS = new Set([
  "-m",
  "-F",
  "-C",
  "-c",
  "-t",
  "--message",
  "--file",
  "--template",
  "--author",
  "--date",
  "--reuse-message",
  "--reedit-message",
  "--fixup",
  "--squash",
]);

/**
 * The command with heredoc and here-string bodies removed.
 *
 * A commit message is text, and a message that explains why `git add -A` is
 * refused is not an attempt to run it.
 */
function withoutBodies(text) {
  const kept = [];
  let terminator = null;
  let hereString = false;

  for (const line of text.split(/\r?\n/u)) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    if (hereString) {
      if (/^['"]@/u.test(line)) hereString = false;
      continue;
    }

    kept.push(line);

    const heredoc = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/u.exec(line);
    if (heredoc !== null) terminator = heredoc[2];
    else if (/@['"]\s*$/u.test(line)) hereString = true;
  }

  return kept.join("\n");
}

/** Words and operators, with quotes honoured the way a shell honours them. */
function tokens(text) {
  const out = [];
  let word = "";
  let quote = null;
  let started = false;

  const flush = () => {
    if (started) out.push({ word });
    word = "";
    started = false;
  };

  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (";&|()\n".includes(char)) {
      flush();
      out.push({ operator: char });
      continue;
    }
    if (/\s/u.test(char)) {
      flush();
      continue;
    }
    word += char;
    started = true;
  }

  flush();
  return out;
}

/** The simple commands in a token stream: runs of words between operators. */
function commandsIn(stream) {
  const commands = [];
  let current = [];

  for (const token of stream) {
    if (token.operator !== undefined) {
      if (current.length > 0) commands.push(current);
      current = [];
    } else {
      current.push(token.word);
    }
  }

  if (current.length > 0) commands.push(current);
  return commands;
}

/** Whether one simple command stages everything. */
function stagesEverything(words) {
  // Leading assignments: `GIT_DIR=x git add -A`.
  let at = 0;
  while (at < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[at])) at += 1;

  const program = words[at] ?? "";
  if (!/(^|[\\/])git(\.exe)?$/iu.test(program)) return false;

  at += 1;
  while (at < words.length && words[at].startsWith("-")) {
    at += GIT_VALUE_OPTIONS.has(words[at]) ? 2 : 1;
  }

  const subcommand = words[at];
  const args = words.slice(at + 1);

  if (subcommand === "add") {
    return args.some((arg) => ADD_EVERYTHING.has(arg) || /^-[A-Za-z]*A[A-Za-z]*$/u.test(arg));
  }

  if (subcommand === "commit") {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (COMMIT_VALUE_OPTIONS.has(arg)) {
        index += 1;
        continue;
      }
      if (arg === "--all" || /^-[A-Za-z]*a[A-Za-z]*$/u.test(arg)) return true;
    }
  }

  return false;
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  let blocked = false;

  try {
    const command = JSON.parse(input)?.tool_input?.command ?? "";
    blocked = commandsIn(tokens(withoutBodies(command))).some(stagesEverything);
  } catch {
    process.exit(0);
  }

  if (!blocked) process.exit(0);

  process.stderr.write(
    "Blocked: this stages every changed file in the tree (`git add -A`, `.`, `-u`, `:/`, " +
      "or `git commit -a`). A working tree may hold somebody else's half-finished edit, and " +
      "this would commit it under your message. Stage the paths you touched, by name: " +
      "`git add path/one.ts path/two.ts`.\n",
  );
  process.exit(2);
});
