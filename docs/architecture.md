# Architecture

This document is the source of truth for how this bot is built. It exists so that a
feature written today and a feature written in a year look like they were
written by the same person, and so that neither one quietly turns the codebase
into a tangle of discord.js calls.

Read [§ The rules](#4-the-rules) before your first change, and
[docs/conventions.md](conventions.md) while you work.

Most of these rules are enforced by tooling. That is deliberate: a rule nobody
checks is a rule that decays, and the checking should not be a person's job.

---

## 1. Philosophy

**Feature-sliced hexagonal.** Each feature is a self-contained slice with a pure
core surrounded by adapters. A shared platform provides infrastructure. Features
do not know about each other.

The alternative — global `domain/`, `application/`, `infrastructure/`,
`presentation/` directories — was considered and rejected (ADR-0001). It reads
well in an article and navigates badly at forty features: one change touches
four distant folders, and `application/use-cases/` becomes a flat list of two
hundred files with no grouping.

Three decisions do most of the work. Everything else follows from them.

### Decision 1 — discord.js lives in exactly one directory

Not "business logic shouldn't depend on discord.js" as advice. **`discord.js` is
import-banned everywhere except `src/discord/`**, and the ban is enforced by
ESLint.

Feature code — including its Discord-facing adapter in `features/*/api/` — talks
to a small framework-agnostic contract:

```ts
interface CommandContext {
  readonly correlationId: string;
  readonly actor: Actor; // materialised: ids, roles, permissions
  readonly guild: GuildRef | null; // an id and a name, not a Guild object
  readonly channel: ChannelRef;
  readonly locale: string;
  defer(visibility?: Visibility): Promise<void>;
  followUp(response: Response): Promise<void>;
}
```

What this buys:

- **Tests need no mocking.** `fakeCommandContext()` is a plain object. Look at
  `tests/features/guild/prefix/api/prefix.command.test.ts`: a real handler, fully
  exercised, with no discord.js in the file.
- **Upgrades touch one directory.** A breaking change in discord.js is a change
  to `src/discord/`, not to every feature.
- **The surface stays small.** Anything a feature needs from Discord has to be
  modelled deliberately, which repeatedly turns out to be an id.

The cost is real: you must model what you need. That cost is the point. It
forces the question "does this use case need the whole `Guild`?", and the answer
is essentially always no.

### Decision 2 — features describe responses, they never build embeds

Use cases return `Result<T, AppError>`. The api layer maps that to a **view
model**:

```ts
type Response =
  | { kind: "success" | "info" | "warning"; text?: string; sections?: Section[] }
  | { kind: "error"; error: AppError }
  | { kind: "text"; content: string } //  a user's own words, undecorated
  | { kind: "list"; items: ListItem[]; page: PageInfo }
  | { kind: "confirm" | "form" | "none"; ... };
```

**One sentence, one frame.** An outcome carries `text` — not a headline and a
paragraph — and renders as `✅ Saved the welcome message.` in an embed coloured
by its kind. The shape has nowhere to put a second line, which is what keeps a
confirmation from growing into a paragraph one reply at a time. `sections` go
under that sentence when a response has structure to lay out, and a settings
panel is the same frame with more in it. Every reply the bot makes about its own
work takes this shape, so the bot reads as one bot.

`kind: "text"` is the exception with no bot voice at all. A welcome greeting is
a server owner's sentence, and it arrives as they wrote it — no icon, no box,
and mentions that resolve, because that is the point of `{user}`. `@everyone`
never resolves, so a template cannot become a mass ping nobody typed.

`src/discord/ui/render.ts` is the only code in the repository that constructs an
`EmbedBuilder`. Features cannot produce an inconsistent UI because they cannot
produce UI at all — only intent.

This is what makes visual consistency structural rather than a code-review
habit. It also makes UI assertions cheap: tests assert the view model, and
rendering is tested once.

**Replies are public unless a command says otherwise.** A bot whose output
nobody can see is a bot nobody can tell is working, and a channel full of
"only you can see this" is a channel with no record of what happened.
`visibility: "ephemeral"` is the deliberate choice for output that is genuinely
private — a settings panel, someone's own totals. Errors are the exception and
are private by default, decided once in the renderer so that no command can leak
a failure into a busy channel by forgetting.

### Decision 3 — environment differences are resolved by wiring

Redis in production, no Redis in development, is a **composition** concern.
`src/app/wiring.ts` decides which implementation of `Cache` and `Lock` to
construct. Not one line of feature code knows the difference.

Grep for `redis.enabled` outside `platform/config/` and `app/wiring.ts` and you
will find nothing. The consequence: **development exercises the same code paths
production runs.** A bug cannot hide behind an environment check, because there
is no environment check for it to hide behind.

---

## 2. Directory structure

```
src/
├── main.ts              process entry — signals and fatal errors, no logic
│
├── app/                 the composition root; the ONLY wiring code
│   ├── bootstrap.ts       startup and shutdown order
│   ├── wiring.ts          chooses implementations per environment
│   ├── features.ts        the feature registry — one line per feature
│   └── feature.contract.ts
│
├── platform/            infrastructure primitives, feature-agnostic
│   ├── config/            zod schema; the only process.env reader
│   ├── logging/ context/  Logger port + pino; AsyncLocalStorage
│   ├── database/          pool, typed queries, transactions, migrator
│   ├── cache/ locks/      ports + memory and Redis implementations
│   ├── jobs/ ratelimit/   scheduler, cooldown store
│   ├── metrics/ ops/      registry, event-loop monitor, /healthz /readyz /metrics
│   └── lifecycle/         ordered shutdown
│
├── discord/             the ONLY discord.js code
│   ├── contracts/         CommandContext, Response, descriptors, custom ids
│   ├── kernel/            client, pipeline, registry, deferral, deployment
│   ├── gateway/           outbound governor: budget, ceiling, breaker, queue
│   └── ui/                the design system: tokens and the renderer
│
├── features/            <group>/<name>/, four groups (see below)
│   └── bot/health/
│       ├── feature.ts       manifest + factory
│       ├── api/             Discord adapter — no discord.js
│       ├── application/     use cases + ports/
│       └── infrastructure/  port implementations
│
└── shared/              universal, zero-dependency: Result, errors, types

tests/                   mirrors src/, plus:
├── architecture/        the rules asserted against the source
└── support/             fakes — never reachable from src/
```

### Feature groups

A closed set of four. The point of a group is that it tells you something, which
stops being true the moment anyone can invent one — so an architecture test
enforces the list.

| Group   | For                                                           |
| ------- | ------------------------------------------------------------- |
| `guild` | Operates on a server: settings, tickets, moderation, welcome  |
| `user`  | Scoped to a person wherever they are: profile, reminders, fun |
| `bot`   | About the bot itself, usable anywhere: ping, help, info       |
| `owner` | Bot-owner only: diagnostics, administration                   |

A group is a directory and nothing more — no behaviour, no loading rules. It
exists so that forty features are four lists of ten rather than one list of
forty, and so "does this touch guild state?" is answerable from the path.

All four exist from the start, each holding a `.gitkeep` that describes what
belongs there. This is the single deliberate exception to "no empty
directories", and the distinction behind it is worth stating:

- **Groups are a fixed taxonomy.** There will only ever be four, and knowing
  that from the file tree is the point. A skeleton's job is partly to teach its
  own shape.
- **Layers are earned.** `domain/` and `infrastructure/` appear only when a
  feature has a rule to protect or state to store, because their presence is
  information. Creating them empty destroys that signal — which is why
  `bot/health` has no `domain/`.

### What each layer owns

| Layer                        | Owns                                           | Must not contain          |
| ---------------------------- | ---------------------------------------------- | ------------------------- |
| `main.ts`                    | Signals, fatal-error output                    | Anything else             |
| `app/`                       | Startup order, dependency wiring, feature list | Business rules            |
| `platform/`                  | Technical capability behind ports              | Anything feature-specific |
| `discord/contracts/`         | The framework-agnostic interface               | discord.js                |
| `discord/kernel/`            | Dispatch, deferral, registration               | Feature logic             |
| `discord/ui/`                | Every embed and component in the bot           | Feature logic             |
| `features/*/api/`            | Option schemas, policies, presenters           | Business rules, SQL       |
| `features/*/application/`    | Use cases, port interfaces                     | Discord, SQL, env         |
| `features/*/domain/`         | Entities, value objects, rules                 | Everything external       |
| `features/*/infrastructure/` | Port implementations                           | Business rules            |
| `shared/`                    | Result, AppError, branded types                | Dependencies of any kind  |

**`shared/` is deliberately tiny.** It is imported by domain code, so it must
stay pure. If something needs a dependency it is not shared — it is platform.
This is the rule that prevents the `utils.ts` black hole.

---

## 3. Dependency direction

```
   discord/kernel · ui · gateway  ──────┐   (imports discord.js)
                                        ▼
                              discord/contracts
                                        ▲
                                        │
                              features/*/api          (no discord.js)
                                        │
                                        ▼
                            features/*/application     (use cases + ports)
                                        │
                                        ▼
                              features/*/domain        (depends on nothing)
                                        ▲
                                        │ implements ports
                          features/*/infrastructure  ──▶ platform/
```

### Allowed

| From              | May import                                                              |
| ----------------- | ----------------------------------------------------------------------- |
| `domain/`         | its own feature's `domain/`, `shared/`                                  |
| `application/`    | own `domain/`, own `ports/`, `shared/`, platform **contracts**          |
| `api/`            | own `application/`, own `domain/`, `discord/contracts/`, `shared/`, zod |
| `infrastructure/` | own `application/`, own `domain/`, `platform/`, `shared/`, libraries    |
| `discord/*`       | `discord.js`, `discord/contracts/`, `platform/`, `shared/`              |
| `platform/*`      | other `platform/*`, `shared/`, libraries                                |
| `shared/`         | `shared/` only                                                          |
| `app/`            | everything — the only place that may                                    |

### Forbidden

- `domain/` importing anything outside its own domain and `shared/`
- `application/` importing `infrastructure/`, `api/`, `discord/`, or a driver
- any feature importing another feature's internals
- `discord.js` outside `src/discord/`
- `process.env` outside `src/platform/config/`
- anything in `src/` importing anything in `tests/`
- **any circular dependency**

Layer rules do not apply to `*.test.ts`. A test legitimately imports fakes and
crosses boundaries; enforcing layers there would only teach people to suppress
the rules.

---

## 4. The rules

Each rule states what it prevents. If a rule ever seems wrong, see
[§ 15](#15-changing-a-rule) — they are changeable, but deliberately.

### RULE 1 — `discord.js` may only be imported inside `src/discord/`

_Enforced by: ESLint `no-restricted-imports`._

**Why.** A library that leaks everywhere cannot be upgraded, cannot be tested
around, and drags its object graph into places that should hold ids. Confining
it means a use case cannot accidentally depend on a `GuildMember` five calls
deep.

```ts
// BAD — features/tickets/api/ticket.command.ts
import { EmbedBuilder } from "discord.js";

// GOOD
import type { Response } from "#discord/contracts/response.contract.js";
```

There are no exceptions, including for scripts. `deploy-commands.ts` needs the
Discord REST API, so the REST call lives in
`src/discord/kernel/command-deployer.ts` and the script calls that. A rule with
one exception becomes a rule with five.

### RULE 2 — domain code depends on nothing

_Enforced by: dependency-cruiser `domain-is-pure`, plus ESLint bans on `Date`
and `Math.random` in `domain/`._

**Why.** The domain is where rules live, and rules are what you most want to
test exhaustively. If testing one requires a database, a clock, and a Discord
client, it will not be tested exhaustively.

Time and randomness arrive as arguments, so a test is deterministic without
fakes:

```ts
// BAD
close(): void {
  this.closedAt = new Date();
}

// GOOD
close(at: Date): void {
  this.closedAt = at;
}
```

### RULE 3 — use cases depend on ports, never implementations

_Enforced by: dependency-cruiser `application-depends-on-ports`, ESLint driver bans._

**Why.** It is what makes the application layer testable with fakes, and what
makes "replace PostgreSQL" a matter of writing new classes rather than rewriting
business logic.

```ts
// BAD
import pg from "pg";
class CloseTicketUseCase {
  constructor(private pool: pg.Pool) {}
}

// GOOD
import type { TicketRepository } from "./ports/ticket.repository.js";
class CloseTicketUseCase {
  constructor(private tickets: TicketRepository) {}
}
```

The port interface lives with the **application** layer that needs it, not with
the infrastructure that implements it. That is the dependency inversion.

### RULE 4 — features return `Response`, they never render

_Enforced by: RULE 1, plus review._

**Why.** It is the whole basis of visual consistency. See Decision 2.

### RULE 5 — expected failures are `Result` values; `throw` is for bugs

**Why.** A use case that can fail says so in its signature, and the compiler
will not let a caller skip the failure branch.

```ts
// GOOD
const result = await this.closeTicket.execute(input);
if (!result.ok) return { kind: "error", error: result.error };
return present(result.value);
```

Throw for programmer error and genuinely exceptional infrastructure failure. The
pipeline catches those, logs with the correlation id, and renders a safe
message.

### RULE 6 — `process.env` is read only in `platform/config/`

_Enforced by: ESLint `no-restricted-properties`._

**Why.** A stray read is a variable nobody documented, nobody validated, and
nobody put in `.env.example` — discovered in production when it is missing.

Add the variable to `config.schema.ts` with a `.describe()`, and to
`.env.example`. There is nowhere else to add one.

### RULE 7 — features never import each other's internals

_Enforced by: dependency-cruiser `features-are-islands`._

**Why.** It is what keeps a feature deletable by deleting its directory, and
what stops the codebase becoming one object graph with folders drawn on it.

When two features genuinely need to interact, the options in order of
preference: (1) they are one feature; (2) the composition root passes one's port
implementation to the other; (3) an event bus, which does not exist yet and
should be added only with a real second subscriber.

### RULE 8 — environment branching lives only in `app/wiring.ts`

_Enforced by: `tests/architecture/boundaries.test.ts`._

**Why.** See Decision 3. A feature with `if (isDevelopment)` inside it has a
code path that production never runs and tests never cover.

### RULE 9 — no business logic in `main.ts`, event handlers, or command files

**Why.** Logic in an adapter cannot be reused by a job, cannot be tested without
the adapter, and gets duplicated the moment a second trigger needs it.

A command file should read as: declare policy → call use case → map result. If a
command file has an `if` about business state, it belongs in a use case; if it
has an invariant, it belongs in the domain.

### RULE 10 — every command declares its authorization explicitly

_Enforced by: the type system — `authorize` is a non-empty tuple._

**Why.** An empty policy list is indistinguishable from an author who forgot,
and "did you mean to leave this open?" is unanswerable in review. `openToEveryone()`
is a decision someone wrote down.

### RULE 11 — no abstraction without a second use case in sight

**Why.** An interface with one implementation and no prospect of a second is
indirection without benefit: it makes the code harder to follow and easier to
believe is flexible when it is not.

This applies to the platform too. There is currently no HTTP client and no
domain event bus, because nothing needs them. Adding an unused abstraction
"for later" is the mistake this rule exists to prevent.

### RULE 12 — cache keys come from declared namespaces

_Enforced by: the `Cache` API takes a `CacheNamespace`, not a string._

**Why.** A keyspace built by string concatenation cannot be enumerated, has TTLs
that drift per call site, and cannot answer "who owns this key?".

A namespace carries its own `owner`, `ttlMs`, and `description`, and is declared
by the feature that uses it — beside the code that reads it, not in a central
catalogue every feature has to edit. See
`src/features/bot/health/infrastructure/cache.health-check.ts`.

---

## 5. Conventions

The full naming and file-layout harness is in
**[docs/conventions.md](conventions.md)** — keep it open while working. It is
enforced by `eslint-plugin-check-file` and `@typescript-eslint/naming-convention`.

The short version: directories are `kebab-case`; files are `kebab-case` plus a
**role suffix** (`ticket.entity.ts`, `close-ticket.usecase.ts`,
`ticket.pg-repository.ts`); no `utils.ts`, `helpers.ts`, or `index.ts` barrels.

---

## 6. Recipes

### Add a command

1. Write the use case in `application/`, returning `Result`.
2. Declare the descriptor in `api/<name>.command.ts` with `defineCommand`:
   input schema, `authorize`, optional `cooldown`.
3. Map the result to a `Response`. Do not build an embed.
4. Add it to the feature's `commands` array in `feature.ts`.
5. `pnpm commands:deploy`.

The command name is its spoken form — `"ticket open"`. The deployer regroups
flat names into Discord's command/group/subcommand tree.

You get the message form free: with `COMMAND_PREFIX` set, `!ticket open x` runs
the descriptor you just wrote. There is nothing to register and nothing to
deploy — see [§ Message commands](#message-commands).

### Split `api/` as a feature grows

`api/` is where a feature sprawls if nothing stops it. Every file in it must
carry one of six roles, and an architecture test enforces the list — so
`api/ui.ts`, `api/embeds.ts` and `api/helpers.ts` fail rather than becoming
whatever is convenient.

| File                  | Owns                                                     |
| --------------------- | -------------------------------------------------------- |
| `<name>.command.ts`   | Policy and orchestration: authorize, call, present       |
| `<name>.component.ts` | Button and select handlers                               |
| `<name>.modal.ts`     | Modal submissions                                        |
| `<name>.event.ts`     | Gateway event adapters                                   |
| `<name>.presenter.ts` | **Everything a user reads** — the `Response` view models |

The presenter is the one people skip, and the one that decides whether `api/`
survives contact with a real feature. A command that also carries its copy is a
file where policy, orchestration and wording are interleaved, and that is a
state it does not come back from. A second test catches the drift early: past a
handful of inline responses in a `.command.ts`, it fails and names the fix.

A large feature is then many small files rather than a few enormous ones:

```
api/
├── panel.command.ts            /panel create | edit | delete | send
├── panel.component.ts          the buttons on a panel
├── panel-questions.component.ts   the question editor's controls
├── panel-questions.modal.ts       the question editor's forms
├── panel.presenter.ts          the panel embed, the list, confirmations
└── panel-questions.presenter.ts   the editor's screens
```

Splitting by **surface** — one presenter per screen, one component file per
control group — rather than by size. That way a change to how the question
editor looks has one file to open, and the file it is in is the one its name
promised.

### Add a subcommand

Same as above with a space-separated name (`"ticket close"`). No extra wiring:
`command-builder.ts` groups by the first word.

### Add a button, picker, or modal

1. Build the custom id with `buildCustomId(scope, action, payload)` — never a
   string literal. Ids are capped at 100 characters, enforced at construction.
2. Declare a `defineComponent({ scope, action, authorize, handle })`.
3. Register it in the feature's `components` array.

`ownerOnly` defaults to true. Set it false only for shared controls such as a
public panel.

A command that opens a modal must declare `defer: "never"` — Discord accepts a
modal only as the first reply.

**A component's reply replaces the message it came from.** The pipeline uses
`deferUpdate` and `editReply` for anything arriving from a message — a button,
a picker, and a modal opened from either — so returning a `Response` re-renders
the panel in place. That is what makes a multi-step editor feel like one screen
instead of a growing stack of stale copies, each with live controls. A _failure_
is the exception: it arrives beside the panel and leaves it standing, because
replacing a panel with an error takes away the controls needed to fix it.

**A picker beats listing things yourself.** `select: { of: "channel" | "role" |
"user", customId }` on a `success` or `info` response renders a native Discord
select, and the ids the user chose arrive as `context.selected`. Discord
resolves the options, so the bot makes no API call, never shows a stale name,
and gets search and permission filtering for free. Channel pickers are narrowed
to the channels a bot can post in — offering a category is offering a choice
that fails later, in front of a user.

### Add a use case

One class, one `execute`, constructor-injected ports, returns `Result`. If it
passes ~80 lines, something in it is probably a domain rule.

### Add a repository

1. Interface in `application/ports/<name>.repository.ts`, in domain terms.
2. Implementation in `infrastructure/<name>.pg-repository.ts`, SQL only.
3. Write an in-memory fake for tests. A port without a fake is a port whose
   consumers cannot be tested.

### Add a migration

```bash
pnpm db:migrate:new create-widgets
```

Edit the generated `.up.sql`, and the `.down.sql` or delete it if the change
cannot be safely reverted. Migrations run automatically at startup.

**Never edit an applied migration.** Checksums are recorded, and a changed file
is a startup failure — because the edit is silent on your machine and produces a
different schema everywhere else.

### Add a job

`{ id, everyMs, singleton, run(signal) }`, registered in the feature's `jobs`
array. The handler calls a use case and contains no logic.

Set `singleton: true` for anything with side effects, and **check `signal`
between steps** — it aborts when a lease is lost, and work continuing past that
point is work running twice.

### Add a feature

```bash
pnpm new:feature user reminders
```

Then add one line to `src/app/features.ts`. Start with `api/` and
`application/`; add `domain/` when there is a rule to protect and
`infrastructure/` when there is state to store. Creating empty directories "for
consistency" teaches the opposite of what the layering is for — `health/` has no
`domain/` precisely because it has no rules.

---

## 7. Configuration

One zod schema in `platform/config/config.schema.ts`, parsed once, frozen,
deeply typed. Every field carries a `.describe()`, which is printed next to the
problem when validation fails.

Validation reports **every** problem at once. Fixing configuration one restart
at a time is miserable.

The runtime profile exposes _capabilities_, not environments:

```ts
config.profile.showErrorDetail; // not: config.env === "development"
config.profile.commandScope;
config.profile.loadDevOnlyFeatures;
```

This is what makes RULE 8 natural to follow rather than a discipline.

---

## 8. Errors

| Class                             | When                                                      |
| --------------------------------- | --------------------------------------------------------- |
| `ValidationError`                 | Input failed its schema. Raised before the use case runs. |
| `AuthorizationError`              | The actor may not do this.                                |
| `NotFoundError` / `ConflictError` | Addressed thing is missing / state disagrees.             |
| `RateLimitError`                  | Cooldown or abuse limit.                                  |
| `DomainError`                     | Abstract. Features extend it with specific, named errors. |
| `InfrastructureError`             | A dependency failed.                                      |
| `ConfigurationError`              | Startup configuration was invalid.                        |
| `DiscordError` / `InternalError`  | API failure / wrapped unexpected throw.                   |

Every error carries `userMessage` (safe to show) and `detail` (internal only).
The split is made when the error is _created_, not when it is displayed, so no
handler can leak internals by choosing the wrong string. `detail` is rendered in
development and never in production.

`severity` decides log level. Expected failures log at `info`; logging them at
`error` trains people to ignore the error level.

### One voice

A feature declares its failures in `domain/<name>.errors.ts` — one class per
failure, so the name appears in logs and a caller could narrow on it. It does
**not** write the sentence:

```ts
// The rule composes the wording; the class only carries code and severity.
err(new InvalidPrefixError(say.tooLong("A prefix", MAX_PREFIX_LENGTH)));
```

`say` is [`src/shared/errors/phrasing.ts`](../src/shared/errors/phrasing.ts) —
the bot's whole vocabulary for going wrong, with the voice documented at the
top: short, bold the operative word, backtick anything literal, and name the way
forward when there is one.

The drift this prevents is subtle and permanent. Left to themselves, two
features written a year apart produce "must be **8 characters** or fewer" and
"cannot exceed 8 chars". Both are fine sentences. Together they read as two
different bots, and by the time anyone notices there are forty of them.

Two tests hold it in place: every error code must be `FEATURE_REASON`, and a
rules file that constructs errors must compose its wording from `say` rather
than inventing prose. A genuinely unique sentence is still allowed — the rule is
that a _reusable_ phrase has exactly one home.

### Messages a user writes

Anywhere someone authors text the bot later sends — a welcome message, a leave
message, an autoresponder — substitution goes through
[`shared/text/template.ts`](../src/shared/text/template.ts) with a **catalogue**:

```ts
render(message, MEMBER_PLACEHOLDERS, {
  userId,
  userName,
  serverId,
  serverName,
  memberCount,
  channelId,
});
```

The base set is `{user}` `{user.name}` `{user.id}` `{user.created}` `{server}`
`{server.id}` `{server.count}` `{server.ordinal}` `{channel}` — dotted and
grouped, with the bare form reserved for the one shape each is almost always
wanted in. There are no aliases on purpose: two spellings of one value is two
things to document, two to test, and one that will be forgotten when the other
changes.

One catalogue drives both rendering _and_ typo detection, so adding `{user.id}`
makes it work and stops it being rejected as a mistake in the same edit. Two
lists would drift, and the way anyone finds out is a user being told a valid
placeholder is invalid.

Two properties are load-bearing:

- **Synchronous.** A placeholder needing a Discord API call — an avatar, a
  member's roles — is not added to a catalogue. It would make substitution
  async, then every caller, then the domain rules that use it. Resolve it in
  `api/` and pass the value in as context instead.
- **Single-pass.** A substituted value is never re-scanned, so a member whose
  nickname is literally `{server.count}` does not have it expanded. Users choose their
  own names; that is input, not a curiosity.

---

## 9. Logging

Depend on the `Logger` port, never on pino.

Correlation is automatic. `correlationId`, `guildId`, `userId`, `operation`, and
`environment` are attached from the AsyncLocalStorage request context by a pino
mixin — **no call site passes them**:

```ts
logger.info("ticket opened", { ticketId }); // correlation arrives free
```

Never log: tokens, connection strings, authorization headers, raw interaction
objects, or user message content. A redaction list is a backstop, not the
policy.

Two backstops, because they catch different things. Redaction by **key path**
(`token`, `*.password`, `connectionString`) censors a secret sitting at a named
field. It cannot reach one spliced into the _text_ of a driver's error — a
dropped database or Redis connection puts the whole `postgres://user:pw@host`
URI in `message` and again in `stack` — so the error serialiser scrubs the
userinfo segment out of both, keeping the scheme and host an operator actually
needs. Every level serialises its `error`, not only `error` and `fatal`: a
native `Error` has non-enumerable `message` and `stack`, so a `warn` that
handed one straight to pino used to log `{}`.

---

## Message commands

`!ping` runs the same descriptor as `/ping`. Not a parallel implementation — a
second door into the same room:

```
/ping  →  interaction  →  InteractionResponder  ┐
                                                 ├→  the same run():
!ping  →  message      →  MessageResponder      ┘   cooldown → validate →
                                                    authorize → defer →
                                                    handle → render
```

Both responders satisfy one `Responder` interface, so the pipeline cannot tell
which arrived. That is the whole design: guards, deferral, error mapping and
metrics exist once, and a command written today gets both forms without
knowing message commands exist.

**Parsing** lives in `src/discord/kernel/message-parser.ts`, deliberately free
of discord.js so it is tested by calling it. It tokenises with quote support,
resolves the longest registered command name (`!ticket open x` beats `ticket`),
and maps positional arguments onto declared options — with a trailing `string`
option taking the rest of the line, so `!remind 5 buy milk` needs no quoting.
Values are coerced loosely and handed to the same zod schema the slash path
uses, because validation must have exactly one owner.

**Three differences are real** and are stated rather than faked:

- **Nothing is ephemeral.** A message answer is visible to the channel;
  `visibility` is honoured on the slash path and ignored here. It is also a
  plain send rather than a reply: a reply reference puts a "replying to…"
  header on every answer and pings the author of a message they are looking
  at, which in a busy channel is a wall of quote headers and a notification
  for something the person just did themselves.
- **Modals cannot open.** Discord only shows one in response to an interaction,
  so a `form` response answers with a note pointing at the slash command.
- **There is no deadline.** An interaction must be acknowledged within three
  seconds; a message need never be. So a command's `defer` mode is ignored on
  this route — it exists to survive that deadline — and typing is shown only
  once a handler has been running for `TYPING_AFTER_MS` (400 ms). A quick
  command therefore sends no typing indicator at all and simply replies, and
  `!ping` reports a dash for its round trip rather than making an API call
  purely to have something to measure.

**The intent is the catch.** Reading message text needs the privileged Message
Content intent, and requesting one the application has not been granted makes
the gateway refuse the login outright. So `COMMAND_PREFIX` has no default:
unset means off means the intent is never requested, and a deployment that
never mentioned it cannot be broken by it. `.env.example` ships `!`, which is
what turns it on for local development. When the intent is missing,
`lifecycle.ts` converts Discord's "disallowed intents" into the two-line fix.

---

## 10. Development mode

Development runs **without Redis**, on purpose.

|              | Development           | Production                         |
| ------------ | --------------------- | ---------------------------------- |
| Cache        | `MemoryCache`         | `TieredCache` (memory + Redis)     |
| Locks        | `LocalLock`           | `RedisLock` (lease + stop-on-loss) |
| Redis        | not required          | optional — see below               |
| Commands     | guild-scoped, instant | global                             |
| Logs         | pretty, `debug`       | JSON, `info`                       |
| Error detail | shown                 | hidden                             |

Documented degradations, printed at startup: caches are per-process and lost on
restart; singleton jobs use a process-local mutex and are unsafe with more than
one instance; cooldowns reset on restart.

Production is allowed to run this way. The constraint is not "development or
production", it is **one instance or several** — and a single-instance bot is a
perfectly normal way to deploy. Refusing to boot without Redis would make the
simplest useful deployment the one this skeleton rejects, so instead the
production path logs the constraint in capitals and leaves the decision with the
person deploying. Set `REDIS_URL` before raising the replica count.

```bash
pnpm db:start          # real PostgreSQL, no Docker needed
pnpm db:migrate
pnpm commands:deploy
pnpm dev
```

`docker compose up -d postgres` is equivalent; both listen on 55432 with the
same credentials, so `DATABASE_URL` never changes between them.

---

## 11. Performance and reliability

Discord gives **3 seconds** to acknowledge an interaction. Everything below is
downstream of that.

Targets, measured rather than assumed: p50 ack < 100 ms, p99 < 500 ms, zero
timeouts, event-loop delay p99 < 50 ms.

**Adaptive deferral** is the mechanism that makes a timeout structurally
impossible. `defer: "auto"` arms a timer at 1.2 s; if the handler finishes
first the timer is cleared and the reply is direct. Fast commands never show
"thinking…"; slow ones cannot fail.

**Rules for the hot path:**

- Never block the event loop. Anything CPU-bound goes to a job or a worker
  thread. Event-loop delay is gauged and logged past threshold, because a
  blocked loop presents as "Discord is slow" and is otherwise near-invisible.
- A warm command should touch the database **zero times**. Guild-scoped
  configuration belongs in the cache.
- Watch the per-request query counter in the completion log. A rising count is
  an N+1 announcing itself.
- Ship indexes with the migration that needs them.
- Prefer `Promise.all` over sequential awaits when calls are independent.
- Authorization is a pure function over the materialised `Actor` — never an API
  call.

`statement_timeout` sits below the ack budget so a pathological query fails fast
instead of losing the interaction.

### Query retry

A failed query is retried only when the failure says it is safe to. The rules
live in `platform/database/retry.policy.ts` as pure functions, so they can be
tested exhaustively — reproducing a mid-query failover in a test suite is not
practical, but asserting the decision table is.

The distinction that matters is not "did it fail?" but **"did it run?"**:

| Failure                                                                 | Retried?                                                                                             |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Connection failure (`ECONNREFUSED`, `08006`, …)                         | **Always** — the statement never reached the server                                                  |
| Transient server error (`57P01` failover, `53300` too many connections) | **Reads only**, and never inside a transaction                                                       |
| Statement timeout (`57014`)                                             | **Never** — it will time out again, and retrying spends the ack budget guaranteeing a second failure |
| Syntax error, constraint violation, permission denied                   | **Never** — identical result every time                                                              |

A write that reached the server may have applied, so retrying it is how you get
two of something. Inside a transaction the session is already aborted, so a
retry achieves nothing.

Total retry time is bounded by `DATABASE_RETRY_DEADLINE_MS` (default 2 s), below
the 3-second acknowledgement window — **retrying can never be the reason an
interaction is lost**. Backoff uses full jitter, because without it every
connection dropped by a failover retries in lockstep and arrives as a herd
exactly when the server can least absorb one.

### Outbound Discord governor

Every outbound Discord API call goes through `discord/gateway/outbound.limiter.ts`.

It protects against the failure mode that takes a bot down _globally_: one guild
— usually mid-raid — generating enough calls to exhaust the rate-limit
allowance, at which point Discord's 429s apply to every guild the bot is in.

Four mechanisms, each with its own tested unit:

- **Per-guild budget** — a rolling window, so one server's burst is contained
  rather than shared out.
- **Process-wide ceiling** — because per-guild budgets say nothing about the
  total. A bot in a thousand guilds can respect every per-guild budget and still
  sail past Discord's global limit, at which point 429s apply everywhere. The
  ceiling sits deliberately under that limit, so the bot sheds load before
  Discord starts refusing.
- **Round-robin draining** — the sweep rotates its starting lane, so a saturated
  ceiling cannot leave the same guilds permanently at the back of the queue.
- **Per-guild-and-feature circuit breaker** — keyed on both, because "the bot
  lost permissions in this server" and "this feature calls a broken endpoint"
  are different failures and a single breaker would catch neither in time. After
  a cooldown it admits exactly one probe, so a recovering dependency is not
  immediately re-flooded.
- **Priority queue** — `Critical` never queues and never drops; overflow evicts
  from the bottom. A raid flooding the bot with cosmetic work delays the
  cosmetic work, not the moderation action taken in response to it.
- **Concurrency cap and queue timeout** — bounded, so pressure produces refusals
  rather than unbounded memory growth.

It returns `Result`, never `null`. A dropped action is a real outcome the caller
must decide about, and a nullable return is too easy to treat as success.

**Interaction replies deliberately do not pass through it.** They use the
interaction token, which Discord rate-limits separately from guild and channel
routes; budgeting them against a per-guild allowance would model the wrong
thing, and adding a queue to the latency-critical path would risk the 3-second
window for no benefit.

> **Note — a deliberate exception to RULE 11.** The governor currently has no
> caller: `/ping` only replies to an interaction. It is wired anyway because
> retrofitting a governor across a grown codebase is call-site-by-call-site
> work, and because the first feature that sends a message should find the paved
> road already there. This is the _only_ speculative component in the codebase,
> and it is named as such rather than quietly justified.
>
> Feature `infrastructure/` may import `discord/gateway/` for exactly this
> reason — deliberately narrower than all of `src/discord/`, and discord.js
> stays banned regardless.

---

## 12. Testing

Layers do not deserve equal testing.

| Layer             | How                                              | How much      |
| ----------------- | ------------------------------------------------ | ------------- |
| `domain/`         | Pure unit tests. No mocks, no async.             | **Highest**   |
| `application/`    | Use cases against hand-written in-memory fakes.  | **High**      |
| `api/`            | `fakeCommandContext()`; assert the **Response**. | Medium        |
| `infrastructure/` | Integration tests against real PostgreSQL.       | Medium        |
| `discord/`        | Pipeline stages; one rendering suite.            | Low, non-zero |
| `app/`            | Smoke test that the container assembles.         | Minimal       |

**Mock nothing you own the interface of — write a fake.** Fakes behave like the
real thing, are reusable, and fail to compile when an interface changes, which
is precisely the feedback a mock swallows.

**Never mock `pg`.** A mocked query proves nothing about SQL. Use a real
database.

**Never test discord.js.** It is someone else's library, and the contract
boundary means you do not have to.

Every test lives in `tests/`, mirroring `src/`, so `src/` reads as exactly what
ships. The cost of that separation is drift — a renamed source file quietly
leaves its test testing nothing — so an architecture test fails on any test
without a matching source file, and on any test file found under `src/`.

---

## 13. Security

- Secrets come from config, are redacted in logs, and never reach a
  `userMessage`.
- Every SQL statement is parameterized. String-built SQL is not acceptable.
- `AuthorizationError` deliberately does not distinguish "not allowed" from
  "does not exist", to avoid confirming existence.
- Components are `ownerOnly` by default, so one user cannot drive another's
  confirmation dialog.
- `/metrics` is bearer-guarded with a constant-time comparison. The token is
  optional, so that an unset variable never becomes an open endpoint: with no
  token, production does not serve `/metrics` at all. Unset means off, not open.
- Custom id payloads are untrusted input: they are parsed, never `eval`'d, and
  malformed ones are a routing miss rather than a crash.

---

## 14. How the rules are enforced

| Tool                                                                              | Owns                                                                                                           |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **TypeScript** (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) | Contracts, non-empty `authorize`, `Result` exhaustiveness                                                      |
| **ESLint**                                                                        | Package bans, `process.env`, filenames, folders, symbol naming, import order, size ceilings, floating promises |
| **dependency-cruiser**                                                            | Layer edges, same-feature isolation, **cycles**                                                                |
| **`tests/architecture/`**                                                         | The same boundaries asserted against the source, plus RULE 8, which no lint rule expresses well                |
| **Prettier**                                                                      | Formatting — never discussed in review                                                                         |

```bash
pnpm verify   # typecheck + lint + format + architecture + tests
```

CI runs all of it on every pull request, and each step runs even if an earlier
one failed, so one push reports every problem.

The architecture tests deliberately overlap the lint rules. A lint rule can
be disabled in a config file or suppressed inline, and neither shows up in a
diff as clearly as a failing test named after the rule it protects.

Deliberately **not** used: TypeScript project references (real build cost,
marginal benefit at this size), and any runtime architecture validator.

---

## 15. Changing a rule

The rules are not sacred; they are load-bearing. If one is wrong:

1. Say which rule and what it is costing, with a concrete example.
2. Propose the replacement, including what enforces it.
3. Change the rule here, change the enforcement, then change the code — in that
   order, so the codebase is never in a state where the docs and the tooling
   disagree.
4. Record it as an ADR in `docs/adr/`.

What is not acceptable is a suppression comment with no explanation. If a rule
must be broken for a specific case, say why in the code:

```ts
// eslint-disable-next-line no-restricted-imports -- <why, and when this can go>
```

---

## Architecture decision records

| ADR                                          | Decision                                     |
| -------------------------------------------- | -------------------------------------------- |
| [0001](adr/0001-feature-sliced-hexagonal.md) | Feature slices over global horizontal layers |
| [0002](adr/0002-discord-containment.md)      | discord.js confined to one directory         |
| [0003](adr/0003-hand-written-di.md)          | A composition root, not a DI framework       |
| [0004](adr/0004-raw-sql-behind-ports.md)     | Raw SQL behind repository interfaces         |
| [0005](adr/0005-result-over-exceptions.md)   | `Result` for expected failures               |
| [0006](adr/0006-response-view-models.md)     | Features describe responses                  |
| [0007](adr/0007-wiring-not-branching.md)     | Environments differ by wiring                |
| [0008](adr/0008-reliability-boundaries.md)   | Outbound governor and query retry            |
