# Contributing

The short version: run `pnpm verify` before you push, follow
[docs/conventions.md](docs/conventions.md), and if you need to break an
architecture rule, say which one and why.

Most of the rules here are enforced by tooling rather than by review. That is
deliberate — a rule nobody checks is a rule that decays, and the checking should
not be a person's job.

---

## Working with AI

If you use an AI assistant here, point it at [AGENTS.md](AGENTS.md) — every
major tool reads it automatically. The short version: it must run `pnpm verify`,
and it must never weaken a check to make a change pass.

---

## Setup

Requires **Node 22+** and **pnpm**. Docker is optional.

```bash
pnpm install
cp .env.example .env
pnpm check               # says exactly what is still missing
```

`pnpm check` checks Node, `.env`, your Discord credentials, PostgreSQL, and
Redis, and prints the fix beside each failure. Start there whenever something
will not run.

```bash
pnpm db:start            # real PostgreSQL in .devdb/, no Docker needed
pnpm db:migrate
pnpm commands:deploy     # guild-scoped in development — appears instantly
pnpm dev
```

Redis is **not** required, in development or in production. The bot caches
in-process and locks jobs per-process, prints what that costs at startup, and
only genuinely needs Redis once a second instance exists.

---

## Before you push

```bash
pnpm verify
```

That is typecheck + lint + architecture rules + tests, and it is exactly what CI
runs. If the editor disagrees with it, trust the CLI — a stale ESLint or
TypeScript server is the usual cause, and _Developer: Reload Window_ clears it.
A burst of `no-unsafe-*` errors on a file the CLI says is clean is that, not your
code; never silence it with a cast or a suppression
([why](README.md#editor-setup)).

| Command          | What it catches                                          |
| ---------------- | -------------------------------------------------------- |
| `pnpm typecheck` | Type errors, including tests and scripts                 |
| `pnpm lint`      | Forbidden imports, filenames, naming, unhandled promises |
| `pnpm arch`      | Layer violations, cross-feature imports, **cycles**      |
| `pnpm test`      | Everything else                                          |

---

## Adding a feature

```bash
pnpm new:feature user reminders
```

The first argument is the group: `guild`, `user`, `bot`, or `owner`. That
scaffolds `api/` and `application/` — the two layers every feature needs.
Add `domain/` when there is a rule worth protecting, and `infrastructure/` when
there is state to store. Do not create empty _layer_ directories for consistency;
`health/` has no `domain/` precisely because it has no rules.

Then add one line to `src/app/features.ts`.

The full walkthrough, with code, is in the
[README](README.md#adding-a-command). Recipes for buttons, modals, events, jobs,
and repositories are in [docs/architecture.md § 6](docs/architecture.md#6-recipes).

---

## The rules that matter most

All twelve are in [docs/architecture.md § 4](docs/architecture.md#4-the-rules),
each with a good and a bad example. The five that come up most:

1. **`discord.js` only inside `src/discord/`.** Feature code uses the contracts
   in `#discord/contracts`. This is what makes handlers testable with plain
   objects and no mocking.
2. **Features return `Response`, never embeds.** `src/discord/ui/` is the only
   code that builds one. That is why every reply looks the same.
3. **Use cases depend on ports, not implementations.** The interface lives with
   the application layer that needs it; the implementation lives in
   `infrastructure/`.
4. **Expected failures are `Result` values; `throw` is for bugs.** The compiler
   will not let a caller skip the failure branch.
5. **`process.env` only in `src/platform/config/`.** Add the variable to the
   schema and to `.env.example`. There is nowhere else to add one.

---

## Writing tests

| Layer             | How                                             | How much |
| ----------------- | ----------------------------------------------- | -------- |
| `domain/`         | Pure unit tests. No mocks, no async.            | Highest  |
| `application/`    | Use cases against hand-written in-memory fakes. | High     |
| `api/`            | `fakeCommandContext()`; assert the `Response`.  | Medium   |
| `infrastructure/` | Integration tests against real PostgreSQL.      | Medium   |

**Write fakes, not mocks.** A fake behaves like the real thing, is reusable, and
fails to compile when an interface changes — which is exactly the feedback a
mock swallows.

**Never mock `pg`.** A mocked query proves nothing about SQL.

**Never test discord.js.** It is someone else's library, and the contract
boundary means you do not have to.

Every test lives in `tests/`, mirroring `src/`, so `src/` holds only shipped
code. An architecture test enforces both halves of that: no tests under `src/`,
and no test left orphaned by a source file that moved or was deleted.

---

## Commits and pull requests

Conventional Commits: `feat(tickets): add claim flow`, `fix(pipeline): …`,
`docs: …`, `refactor: …`, `chore: …`.

The pull request template has an architecture checklist. Tick what applies; if
you had to break a rule, say which and why in the description.

---

## Breaking a rule

The rules are load-bearing, not sacred. If one is wrong:

1. Say which rule, and what it is costing, with a concrete example.
2. Propose the replacement — including what enforces it.
3. Change the rule in `docs/architecture.md`, change the enforcement, then
   change the code. In that order, so the docs and the tooling never disagree.
4. Record it as an ADR in `docs/adr/`.

What is not acceptable is a bare suppression. If a rule genuinely must bend for
one case, say why in the code:

```ts
// eslint-disable-next-line no-restricted-imports -- <why, and when this can go>
```

---

## A note on maturity

This is a skeleton. The architecture is enforced and the platform is tested, but
it has not run a production workload: the outbound Discord governor has never
faced a real rate limit, and the retry policy has never seen a real failover.
The decision tables behind both are unit-tested exhaustively — the behaviour
under a genuine outage is not yet proven.

Treat it as a well-built foundation, not a battle-tested one.
