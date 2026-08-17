# Discord Bot Skeleton

A starting point for a serious Discord bot: **Node.js + TypeScript + discord.js**,
on an architecture designed to still make sense at forty features.

It ships with three features, and each is a **reference for one shape a feature
can take** — copy the closest one:

|            |                  | Shows you                                                                     |
| ---------- | ---------------- | ----------------------------------------------------------------------------- |
| `/ping`    | no state         | the wiring end to end, and a scheduled job over the same use case             |
| `/prefix`  | stores a value   | migration → repository → port → cached read → domain rule                     |
| `/welcome` | the full surface | subcommands, a live editor panel, an event, and messages the bot sends itself |

Every one also answers to `!ping`, `!prefix` and `!welcome`, from the same code.

Everything else is foundation, and the rules that keep it a foundation are
enforced by tooling rather than by discipline.

---

## Quick start

Requires **Node 22+** and **pnpm**. Nothing else — no Docker, no Redis.

```bash
pnpm install
pnpm setup
```

It will stop and ask for three values from the
[Discord Developer Portal](https://discord.com/developers/applications). Put
them in `.env`:

|                        |                                               |
| ---------------------- | --------------------------------------------- |
| `DISCORD_TOKEN`        | Bot → Reset Token                             |
| `DISCORD_CLIENT_ID`    | General Information → Application ID          |
| `DISCORD_DEV_GUILD_ID` | Right-click your test server → Copy Server ID |

Then:

```bash
pnpm setup            # again — it should now say "Ready"
pnpm commands:deploy  # only needed when a command changes
pnpm dev
```

Run **`/ping`** in your server. Then `/prefix to:?` and `?ping`, to watch a
setting persist.

From here the loop is `pnpm dev` to run and `pnpm verify` to check your work.

<details>
<summary>If something does not work</summary>

**`pnpm check`** checks your setup and prints the fix beside each failure.
Start there.

**Discord refuses the login.** `.env.example` ships `COMMAND_PREFIX=!`, which
gives every command a message form (`!ping` as well as `/ping`). Reading message
text is privileged, so it needs **Bot → Privileged Gateway Intents → Message
Content Intent** switched on. The bot names this exact fix when it happens — or
set `COMMAND_PREFIX=` blank and the intent is never requested.

**Commands take an hour to appear.** `DISCORD_DEV_GUILD_ID` was not set, so they
deployed globally. Set it and they register to that one server instantly.

**What `pnpm setup` did**, if you would rather run the steps yourself:

```bash
cp .env.example .env
pnpm db:start       # PostgreSQL in .devdb/ — `docker compose up -d postgres`
pnpm db:migrate     #   is equivalent: same port, same credentials
pnpm check
```

</details>

### When you are done for the day

```bash
pnpm stop     # stops the bot and PostgreSQL
```

PostgreSQL is meant to outlive the command that started it, the same way
`docker compose up -d` does, so your data survives between sessions. Nothing is
lost either way.

<details>
<summary>Why the bot sometimes survives closing the terminal</summary>

It handles `SIGHUP`, `SIGINT`, `SIGTERM` and `SIGBREAK`, but Windows does not
guarantee any of them arrive: no signal cascades down a process tree, `pnpm dev`
runs the bot three processes below the shell (`pnpm` → `cmd` → `tsx watch` →
`node`), and whether a closing terminal delivers a console event depends on the
terminal. When it goes wrong you get an invisible bot holding a gateway
connection — which is what `pnpm stop` is for. It matches on this project's
entry point, so a bot in another checkout is never touched.

A deployment is unaffected: there `SIGTERM` is real and the
[ordered shutdown](#operations) runs properly.

</details>

---

## Commands

**These four are the whole job.** If you remember nothing else, remember these:

|                                   |                                                                       |
| --------------------------------- | --------------------------------------------------------------------- |
| `pnpm setup`                      | First run, and any time something is broken — it says what is missing |
| `pnpm dev`                        | Run the bot, reloading on save                                        |
| `pnpm stop`                       | Stop the bot and the database, after a terminal was closed on them    |
| `pnpm verify`                     | Check everything, exactly as CI does. Run before you commit           |
| `pnpm new:feature <group> <name>` | Scaffold a new feature in the right shape                             |

Occasionally:

|                              |                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm commands:deploy`       | Push slash commands to Discord. Needed when a command is added or its options change      |
| `pnpm db:migrate:new <name>` | Start a schema change. `pnpm db:migrate` applies it — though `pnpm dev` does that for you |
| `pnpm db:reset`              | Throw the local database away and rebuild it from the migrations                          |

<details>
<summary>Everything else</summary>

`pnpm verify` runs the first five of these, so you rarely need one on its own —
they exist for when you want a single check to be fast.

|                                                        |                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `pnpm typecheck`                                       | TypeScript, no emit                                                   |
| `pnpm lint` / `pnpm lint:fix`                          | ESLint                                                                |
| `pnpm format` / `pnpm format:check`                    | Prettier                                                              |
| `pnpm arch`                                            | Layer rules and cycle detection                                       |
| `pnpm test` / `pnpm test:watch` / `pnpm test:coverage` | Vitest                                                                |
| `pnpm check`                                           | What is missing from your setup                                       |
| `pnpm db:start` / `pnpm db:stop`                       | Start / stop the local PostgreSQL                                     |
| `pnpm redis:start` / `pnpm redis:stop`                 | Start / stop a local Redis. Optional — needs Docker                   |
| `pnpm db:migrate:status` / `pnpm db:migrate:down`      | Inspect / roll back migrations                                        |
| `pnpm commands:clear`                                  | Remove every registered command                                       |
| `pnpm build` / `pnpm start`                            | Compile to `dist/` / run the build. Railway runs these; you rarely do |

</details>

---

## What you get

|                    |                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform**       | config, logging, request context, metrics, ops endpoints, database, migrations, cache, locks, jobs, cooldowns, ordered shutdown                     |
| **Reliability**    | query retry with failure classification, and an outbound Discord governor — per-guild budget, process-wide ceiling, circuit breaker, priority queue |
| **Discord kernel** | contracts, interaction pipeline, adaptive deferral, registry, command deployment, message commands, outbound messenger                              |
| **Design system**  | tokens and the single renderer every reply passes through                                                                                           |
| **Harness**        | ESLint, dependency-cruiser, architecture tests, CI, and the docs                                                                                    |
| **Features**       | Three references: `bot/health` (no state, a command and a job), `guild/prefix` (stores a value), `guild/welcome` (commands, panel, event)           |

Two migrations ship, creating the tables those features use. `pnpm db:migrate:new`
scaffolds the next, with the conventions in its template.

Two things are deliberately **absent**: an HTTP client and a domain event bus.
Neither has a caller, and RULE 11 — no abstraction without a second use case —
applies to the platform as much as to features.

---

## What this is built with

|                       | Role          | Why this one                                                             |
| --------------------- | ------------- | ------------------------------------------------------------------------ |
| **Node.js 22+**       | Runtime       | LTS, native ESM, built-in `--env-file`                                   |
| **TypeScript 6**      | Language      | Strict, with `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` |
| **discord.js 14**     | Discord API   | Confined to one directory, so it can be upgraded or replaced             |
| **PostgreSQL** (`pg`) | Database      | Raw parameterized SQL behind repository interfaces — no ORM              |
| **Redis** (`ioredis`) | Cache & locks | Optional everywhere — needed only to run more than one instance          |
| **Zod 4**             | Validation    | Command input, and the environment schema                                |
| **Pino**              | Logging       | Structured JSON, with correlation attached automatically                 |
| **Vitest**            | Tests         | Fast, native ESM, no transform step                                      |
| **pnpm**              | Packages      | Strict, fast, disk-efficient                                             |

**Enforcement** — the part that makes the architecture hold:

|                                | Owns                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------- |
| **ESLint** + typescript-eslint | Forbidden imports, filenames, naming, unhandled promises                      |
| **dependency-cruiser**         | Layer boundaries, feature isolation, **circular dependencies**                |
| **Architecture tests**         | The same rules asserted against the source, plus the ones lint cannot express |
| **Prettier**                   | Formatting, so it is never discussed in review                                |

No framework, no ORM, no DI container, no code generation. Six runtime
dependencies in total.

---

## Adding a command

```bash
pnpm new:feature user reminders    # creates api/ and application/
```

**1.** Write what it does, in `application/`. Return a `Result` — the compiler
will not let a caller skip the failure branch.

```ts
export class CreateReminderUseCase {
  constructor(private readonly reminders: ReminderRepository) {}

  async execute(input: CreateReminderInput): Promise<Result<Reminder>> {
    if (input.minutes > MAX_MINUTES) {
      return err(new ReminderTooDistantError(MAX_MINUTES));
    }
    return ok(await this.reminders.save(/* … */));
  }
}
```

**2.** Declare the command in `api/`. Policy, validation, and limits are
declared rather than hand-written — the pipeline enforces them.

```ts
export function createRemindCommand(createReminder: CreateReminderUseCase) {
  return defineCommand({
    name: "remind",
    description: "Remind you about something later",
    options: [
      { type: "string", name: "text", description: "What about", required: true },
      { type: "integer", name: "minutes", description: "In how long", required: true },
    ],
    input: z.object({ text: z.string().min(1).max(200), minutes: z.number().min(1) }),
    authorize: [inGuild()],
    cooldown: { scope: "user", limit: 5, windowMs: 60_000 },
    handle: async (ctx, input): Promise<Response> => {
      const result = await createReminder.execute({ ...input, userId: ctx.actor.userId });
      if (!result.ok) return { kind: "error", error: result.error };
      return { kind: "success", text: `Set a **reminder** for \`${input.minutes}\` minutes.` };
    },
  });
}
```

**3.** Add it to the feature's `commands` array, then one line in
`src/app/features.ts`.

**4.** `pnpm commands:deploy`, then `pnpm dev`.

You now have both `/remind 5 water the plants` **and** `!remind 5 water the
plants`. There is nothing to write for the second: message commands run the
same descriptor through the same pipeline, so the policy, cooldown, validation
and rendering above apply unchanged. Positional arguments map onto your declared
options in order, and a trailing `string` option takes the rest of the line —
which is why the reason above needs no quoting.

Notice what you did **not** do: no embed, no `interaction.reply`, no permission
check, no try/catch, no rate-limit bookkeeping, no logging, no second parser.
The pipeline and the design system own all of it — which is why every command
behaves and looks the same, and why a new one is genuinely a small amount of
code.

Add `domain/` when there is a rule worth protecting, and `infrastructure/` when
there is state to store.

---

## Architecture in one screen

```
Interaction
   ↓
Pipeline          cooldown → validate → authorize → defer → handle
   ↓
api/              Discord adapter — no discord.js, maps Result → Response
   ↓
application/      use cases, depending on ports
   ↓
domain/           entities and rules — depends on nothing
   ↑
infrastructure/   port implementations (PostgreSQL, Discord API)
```

Three decisions carry the design:

1. **`discord.js` exists in exactly one directory.** Feature code talks to a
   small `CommandContext` contract, so handlers are tested with plain objects
   and no mocking.
2. **Features describe responses; they never build embeds.** One renderer owns
   every embed, so visual consistency is structural rather than a habit.
3. **Environments differ by wiring, not by branching.** Redis-or-not is decided
   in one file, so development exercises the same code paths production runs.

The full reasoning, all twelve rules, and recipes for every common task are in
**[docs/architecture.md](docs/architecture.md)**.

---

## What's in this repo

Nothing here is decoration. If a file exists, something enforces a rule with it
or a command runs it. These are the ones you will open:

|                        | What it's for                                                          |
| ---------------------- | ---------------------------------------------------------------------- |
| `src/`                 | The bot. Shipped code only — no tests, no fakes                        |
| `tests/`               | Every test, mirroring `src/`                                           |
| `docs/architecture.md` | The rules, and why each exists. Read before your first change          |
| `docs/conventions.md`  | Naming, one page. Keep it open while working                           |
| `AGENTS.md`            | What every AI tool reads. Cursor, Codex and Zed use this name directly |
| `database/migrations/` | Versioned SQL, applied at startup                                      |
| `.env.example`         | Every setting, annotated. `.env` is yours and is never committed       |

<details>
<summary>Everything else — the harness and the config it runs on</summary>

|                                                                | What it's for                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `eslint.config.js`                                             | Forbidden imports, filenames, naming. **Half the harness**                               |
| `.dependency-cruiser.cjs`                                      | Layer boundaries, feature isolation, cycles. **The other half**                          |
| `tests/architecture/`                                          | The rules asserted against the source. A failure names the rule                          |
| `scripts/`                                                     | Everything behind a `pnpm` command                                                       |
| `package.json`                                                 | Dependencies, scripts, path aliases (`#platform/…`), Prettier config                     |
| `tsconfig.json`                                                | Strict TypeScript. `tsconfig.build.json` excludes tests from the build                   |
| `vitest.config.ts`                                             | Test runner                                                                              |
| `.github/workflows/ci.yml`                                     | Runs the same checks as `pnpm verify`, plus the build                                    |
| `railway.json`                                                 | Build, start and healthcheck, so a deploy needs no manual configuration                  |
| `docker-compose.yml`                                           | Optional Postgres/Redis. `pnpm db:start` does the same without Docker                    |
| `CLAUDE.md`, `.github/copilot-instructions.md`                 | Three lines each, pointing their tool at `AGENTS.md`. Delete either you do not use       |
| `CONTRIBUTING.md`                                              | Setup, the rules that come up most, how to break one properly                            |
| `LICENSE`                                                      | MIT — so others can use this as a base                                                   |
| `.editorconfig`, `.prettierignore`, `.gitattributes`, `.nvmrc` | Consistent formatting and line endings across machines                                   |
| `.vscode/`                                                     | Pins the editor to the project's TypeScript, and nests config files under `package.json` |

</details>

### The three references

Copy whichever is closest to what you are building. Each adds exactly one layer
to the one before it, so the differences are the lesson.

**`bot/health` → `/ping`** — no state. One use case reached two ways: a command
when somebody asks, and a job every five minutes so a database that fell over at
3am shows up in the log at 3am rather than when the next user trips over it.
Notice there is **no `domain/`**: a health check protects no rule, so it gets no
layer to hold one.

```
api/ping.command.ts            policy, input, response
api/health.presenter.ts        every word it says
api/watch-dependencies.job.ts  the same use case, every five minutes
application/
  check-health.usecase.ts      what it actually does
  ports/*.port.ts              "something I can ask if it is alive"
infrastructure/*.ts            those ports, over PostgreSQL / cache / process
```

Adapters are triggers; the thing they trigger is written once.

**`guild/prefix` → `/prefix`** — stores a value. Adds `domain/` and a migration.

```
domain/prefix.rules.ts               the rule — a string in, a decision out
domain/prefix.errors.ts              its failure, with a permanent code
application/ports/*.repository.ts    the interface the use case needs
application/*.usecase.ts             cached read; validate-write-invalidate
api/prefix.presenter.ts              everything the user reads
infrastructure/*.pg-repository.ts    that port, in real SQL
database/migrations/0001_*.sql
```

Read it in that order — rule, then the port it made the use case need, then the
SQL that satisfies it. That direction _is_ the architecture.

**`guild/welcome` → `/welcome`** — everything else. Six subcommands, an editor
panel, and the event that actually greets people.

```
api/welcome.command.ts       message | channel | test | reset | edit
api/welcome.component.ts     the panel's buttons and its channel picker
api/welcome.modal.ts         the form a button opens
api/welcome.presenter.ts     every word and every button, in one file
api/member-joined.event.ts   what actually greets people
database/migrations/0002_*.sql
```

Three things here are worth reading for themselves:

- **The bot speaks first.** Greeting someone is not a reply, so it goes through
  the `Messenger` port — the only way to reach Discord uninvited, and governed
  by the outbound limiter so one guild cannot spend everyone's rate budget.
- **`/welcome test` runs the real path**, not a preview of it. It calls the same
  use case the join event does, so it cannot be right about a channel the
  greeting would fail on.
- **The panel holds no state.** Its buttons carry no payload: every click reads
  the settings and writes them back, and the reply _replaces_ the panel rather
  than posting under it. So an editor opened before a deploy still works after
  one, and there is no session to expire, sweep, or reconcile.

**Two rules these share**, both enforced:

- **`api/` splits by role only** — `.command.ts`, `.component.ts`, `.modal.ts`,
  `.event.ts`, `.job.ts`, `.presenter.ts`. So `api/ui.ts` fails rather than
  becoming a dumping ground, and a big interface is many small named files
  ([how](docs/architecture.md#split-api-as-a-feature-grows)).
- **Failure wording comes from `say.*`**, never inline prose, so two features
  written a year apart reject the same thing with the same sentence.

**Deleting any of them** is one directory, one line in `src/app/features.ts`, and
its migration. Nothing else refers to them.

---

`bot` and `guild` above are **groups**. There are four, and the list is closed
because the point of a group is that it tells you something:

| Group   | For                                                           |
| ------- | ------------------------------------------------------------- |
| `guild` | Operates on a server: settings, tickets, moderation, welcome  |
| `user`  | Scoped to a person wherever they are: profile, reminders, fun |
| `bot`   | About the bot itself, usable anywhere: ping, help, info       |
| `owner` | Bot-owner only: diagnostics, administration                   |

All four exist from the start, each with a `.gitkeep` describing what belongs
there, so the shape is visible the moment you open `src/features/`. Delete the
placeholder once a group holds a real feature.

That is the one place this repo keeps an empty directory on purpose. **Groups
are a fixed taxonomy** — knowing all four exist is the point. **Layers are
not**: `domain/` and `infrastructure/` appear only when a feature earns them,
because their presence is information.

`pnpm new:feature <group> <name>` scaffolds a feature with only what it needs —
a manifest and one command. Add `domain/` when a rule appears, `infrastructure/`
when state does.

---

## Where code goes

| You are adding…             | It goes in…                                                      |
| --------------------------- | ---------------------------------------------------------------- |
| A slash command             | `features/<group>/<name>/api/<name>.command.ts`                  |
| A business operation        | `features/<group>/<name>/application/<verb>-<noun>.usecase.ts`   |
| A rule or invariant         | `features/<group>/<name>/domain/`                                |
| A database query            | `features/<group>/<name>/infrastructure/<name>.pg-repository.ts` |
| An interface for the above  | `features/<group>/<name>/application/ports/`                     |
| Something two features need | `platform/` (with a dependency) or `shared/` (without)           |
| An embed or component       | `src/discord/ui/` — and nowhere else                             |
| A background task           | `features/<group>/<name>/…` + the feature's `jobs` array         |
| A schema change             | `pnpm db:migrate:new <name>`                                     |

Recipes for buttons, modals, events, jobs, and repositories are in
[docs/architecture.md § 6](docs/architecture.md#6-recipes). Naming rules are in
[docs/conventions.md](docs/conventions.md).

---

## Testing

```bash
pnpm verify          # everything CI runs: typecheck, lint, format, architecture, tests
pnpm test            # tests only
pnpm test:watch      # while you work
pnpm test:coverage
```

Tests live in `tests/`, mirroring `src/`. Nothing under `src/` is a test — an
architecture test enforces that, and enforces that no test is left orphaned by a
source file that moved or was deleted.

| Directory                | What it holds                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `tests/architecture/`    | The layering rules asserted against the source. A failure names the rule it protects. |
| `tests/support/`         | Fakes: `fakeCommandContext()`, `MemoryLogger`.                                        |
| `tests/<mirror of src>/` | Everything else.                                                                      |

| Layer             | Approach                                        |
| ----------------- | ----------------------------------------------- |
| `domain/`         | Pure unit tests. No mocks, no async.            |
| `application/`    | Use cases against hand-written in-memory fakes. |
| `api/`            | `fakeCommandContext()`; assert the `Response`.  |
| `infrastructure/` | Integration tests against real PostgreSQL.      |

**Write fakes, not mocks.** Never mock `pg` — a mocked query proves nothing
about SQL. Never test discord.js; the contract boundary means you do not have
to. See `tests/features/guild/prefix/api/prefix.command.test.ts` for an adapter test
with no mocking at all.

---

## Building features with AI

The architecture was designed so an assistant cannot quietly wreck it. Two
things make that work:

**The rules are machine-checked, not documented.** `pnpm verify` runs typecheck,
lint, dependency-cruiser, and the architecture tests. An agent that runs it gets
the same answer a reviewer would, immediately.

**Every tool reads the same instructions.** [`AGENTS.md`](AGENTS.md) is the
source, and Cursor, Codex, Zed and others read that filename directly. The two
that do not — `CLAUDE.md` and `.github/copilot-instructions.md` — are three
lines each and point at it rather than restating it, because a second copy of
the rules is a second copy to drift.

A prompt that works:

> Add a `/remind` command under the `user` group: takes text and minutes, stores
> the reminder, and DMs the user when it is due. Follow AGENTS.md. Run
> `pnpm verify` and fix anything it reports before you finish.

Then check three things in the diff:

1. **Did `pnpm verify` actually pass?** Ask for the output, do not assume.
2. **Did it weaken anything?** Look for changes to `eslint.config.js`,
   `.dependency-cruiser.cjs`, or deleted assertions. `AGENTS.md` forbids this
   explicitly, and it is the one failure the harness cannot catch by itself —
   because the harness is what got edited.
3. **Did it reach for `any` or a suppression?** Both are banned; both are what a
   blocked model tries first.

Everything else the harness will catch on its own.

---

## Deploying to Railway

Three steps. `railway.json` in this repo already sets the build command, start
command, and healthcheck, so there is nothing to configure in Settings.

**1.** Railway → **New Project → Deploy from GitHub repo**, then **+ New →
Database → PostgreSQL**. That is the only service you need.

**2.** On the bot service, **Variables → Raw Editor**, paste this and fill in the
top two:

```
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
```

The last line is Railway's own reference syntax; leave it exactly as written.

**3.** Deploy. Migrations run at startup under an advisory lock, so a rolling
deploy is safe.

### Two optional extras

Neither is required, and the bot runs correctly without both.

**Redis** — add **+ New → Database → Redis** and one variable:

```
REDIS_URL=${{Redis.REDIS_URL}}
```

Without it the bot caches in-process and locks jobs per-process, which is
correct for **one** instance and wrong for two. It says so loudly at startup.
Add Redis before you raise the replica count, not after.

**Metrics** — set `OPS_METRICS_TOKEN` to any long random string to enable
`/metrics`. Left unset, production does not serve that endpoint at all, so
leaving it blank never exposes anything.

Then, **once**, register the commands globally from your machine:

```bash
NODE_ENV=production DISCORD_TOKEN=… DISCORD_CLIENT_ID=… pnpm commands:deploy
```

Global commands can take up to an hour to appear everywhere. Repeat this only
when a command is added or its options change — code changes deploy on push.

Notes that save an afternoon:

- If the deploy fails immediately, read the logs: a missing required variable
  fails the boot and names itself, listing every problem at once.
- `OPS_PORT` falls back to `PORT`, so the healthcheck finds the ops server with
  no extra configuration.
- `/readyz` returns 503 until the database, cache, and gateway are all ready.
  `/healthz` touches nothing, so a database blip cannot cause a restart loop.

Nothing here is Railway-specific beyond `railway.json` — it is a plain Node
process with a healthcheck, so Fly, Render, or a VPS work the same way.

---

## Operations

| Endpoint   | Purpose                                                                          |
| ---------- | -------------------------------------------------------------------------------- |
| `/healthz` | Liveness. Touches no dependency, so a database blip cannot cause a restart loop. |
| `/readyz`  | Readiness. Runs every registered probe; 503 when degraded.                       |
| `/metrics` | Prometheus exposition. Bearer-guarded; required in production.                   |

Logs are structured JSON in production and pretty in development, and every line
carries `correlationId`, `guildId`, `userId`, and `operation` automatically —
no call site passes them.

`SIGTERM` triggers an ordered shutdown — jobs, then the gateway, then Redis,
then the pool — bounded by `SHUTDOWN_TIMEOUT_MS`.

---

## Editor setup

Open the folder in VS Code and accept the two prompts:

| Prompt                                   | Why it matters                                                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Install recommended extensions**       | ESLint is half the architecture harness. Without it you find violations at CI instead of as you type.                               |
| **Use the workspace TypeScript version** | The editor and `pnpm typecheck` must agree. VS Code ships its own TypeScript; when the two differ you get errors that do not exist. |

`.vscode/settings.json` also turns on format-on-save, ESLint auto-fix on save,
and file nesting — which collapses the config files under `package.json`, so the
root reads as a handful of entries instead of twenty.

**If the editor disagrees with `pnpm verify`, trust the CLI.** A stale ESLint or
TypeScript server is the usual cause; _Developer: Reload Window_ clears it.

<details>
<summary>The one that looks real: a file lights up red and <code>pnpm lint</code> is clean</summary>

A file — often one you just opened — fills with `@typescript-eslint/no-unsafe-*`
errors, sometimes twenty at once, while `pnpm lint` and `pnpm typecheck` both
pass:

```
Unsafe assignment of an error typed value.
Unsafe call of a type that could not be resolved.
Unsafe member access .id on a type that cannot be resolved.
Unsafe argument of type error typed assigned to a parameter of type `Snowflake`.
```

**Nothing is wrong with your code.** The words to notice are _error typed_ and
_could not be resolved_ — not the ordinary complaint about `any`. They mean the
linter's TypeScript program failed to resolve a type at all, so typescript-eslint
treats it as the error type and every expression downstream inherits the poison.
One unresolved import is enough to produce the whole cascade, which is why the
count is alarming and the errors cluster around a single helper's return value.

The cause is `projectService: true` in `eslint.config.js` — the same setting that
makes type-aware linting fast. It builds the program lazily inside a long-lived
server process, and the extension can lint against one that is half-built or
stale. The CLI builds from scratch every run, so it never sees this.

**Fix:** _ESLint: Restart ESLint Server_ from the command palette
(<kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>). If it survives
that, _Developer: Reload Window_.

It tends to appear after editing a file that many others import, after switching
branches, and after a `pnpm install` that moved `typescript`. Confirm with
`pnpm lint` before touching anything — and when the CLI is clean, **do not "fix"
it in the source**. Adding a cast, a `!`, or an `eslint-disable` to silence a
phantom error leaves a permanent scar in exchange for a message that was going to
disappear on its own. `any` and suppressions are banned here for exactly this
reason.

</details>

Not using VS Code? Nothing depends on it — `pnpm verify` is the real check.

The prompt installs four: **ESLint** and **Prettier** (half the harness),
**Error Lens** (errors on the line itself, which matters with this many rules),
and **Pretty TypeScript Errors**.

<details>
<summary>Optional extras — none affect <code>pnpm verify</code></summary>

| Extension                                   | Why                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Dotenv Official**                         | Highlighting for `.env`. It _cloaks_ values by default — the black bars are the extension hiding secrets, not a read-only file. |
| **GitHub Actions**                          | Editing `ci.yml` with schema validation.                                                                                        |
| **GitLens** or **Git History**              | Blame and history inline.                                                                                                       |
| **Container Tools**                         | Only if you use `docker-compose.yml` rather than `pnpm db:start`.                                                               |
| **npm Intellisense**, **Path Intellisense** | Largely redundant — TypeScript already completes import paths, including the `#platform/…` aliases.                             |

</details>

---

## Contributing

Start with **[CONTRIBUTING.md](CONTRIBUTING.md)** — setup, the five rules that
come up most, and how to break one properly.

1. `pnpm verify` must pass. It is what CI runs.
2. Follow [docs/conventions.md](docs/conventions.md) — most of it is
   lint-enforced, so you will be told.
3. The PR template has an architecture checklist. If you broke a rule, say which
   and why; the rules are changeable, but deliberately
   ([§ 15](docs/architecture.md#15-changing-a-rule)).

---

## A note on maturity

The architecture is enforced and the platform is tested, but this has not run a
production workload: the outbound governor has never faced a real rate limit,
and the retry policy has never seen a real failover. The decision tables behind
both are unit-tested exhaustively — the behaviour under a genuine outage is not.

Treat it as a well-built foundation, not a battle-tested one.

MIT licensed. Use it for whatever you like.
