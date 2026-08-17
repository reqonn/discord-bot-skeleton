# Conventions

The one-page reference. Keep it open while working.

The goal is that two people writing two features six months apart produce files
that look like they were written by the same person. Almost everything here is
enforced by `eslint-plugin-check-file` and `@typescript-eslint/naming-convention`,
so it cannot quietly rot.

Reasoning lives in [architecture.md](architecture.md).

---

## Files

Directories are `kebab-case`. Files are `kebab-case` plus a **role suffix**
naming what the file _is_. The suffix is not decoration — lint rules, the
reader, and the layer rules all use it.

| Role              | Pattern                    | Example                            |
| ----------------- | -------------------------- | ---------------------------------- |
| Entity            | `<name>.entity.ts`         | `ticket.entity.ts`                 |
| Value object      | `<name>.vo.ts`             | `ticket-status.vo.ts`              |
| Domain policy     | `<name>.policy.ts`         | `ticket.policy.ts`                 |
| Domain errors     | `<name>.errors.ts`         | `ticket.errors.ts`                 |
| Use case          | `<verb>-<noun>.usecase.ts` | `close-ticket.usecase.ts`          |
| Port — repository | `<name>.repository.ts`     | `ticket.repository.ts`             |
| Port — gateway    | `<name>.gateway.ts`        | `ticket-channel.gateway.ts`        |
| Port — other      | `<name>.port.ts`           | `health-check.port.ts`             |
| Platform contract | `<name>.contract.ts`       | `cache.contract.ts`                |
| Implementation    | `<name>.<tech>-<role>.ts`  | `ticket.pg-repository.ts`          |
|                   |                            | `memory.cache.ts`, `redis.lock.ts` |
| Command           | `<name>.command.ts`        | `welcome.command.ts`               |
| Component         | `<name>.component.ts`      | `ticket.component.ts`              |
| Modal             | `<name>.modal.ts`          | `close-reason.modal.ts`            |
| Presenter         | `<name>.presenter.ts`      | `ticket.presenter.ts`              |
| Event adapter     | `<discord-event>.event.ts` | `channel-delete.event.ts`          |
| Job               | `<verb>-<noun>.job.ts`     | `expire-stale-tickets.job.ts`      |
| Types             | `<name>.types.ts`          | `snowflake.types.ts`               |
| Constants         | `<name>.constants.ts`      | `ticket.constants.ts`              |
| Feature manifest  | `feature.ts`               | exactly one per feature            |
| Test              | `<source>.test.ts`         | `ticket.entity.test.ts`            |

A bare `<name>.ts` is allowed when the name _is_ the role — `result.ts`,
`tokens.ts`, `render.ts`, `guards.ts`.

**`api/` is the exception: no bare names there.** Every file must be one of
`.command.ts`, `.component.ts`, `.modal.ts`, `.event.ts`, `.job.ts` or `.presenter.ts`,
enforced by an architecture test. It is the directory that sprawls otherwise —
see [architecture.md § Split `api/` as a feature grows](architecture.md#split-api-as-a-feature-grows).

**Feature directories** are `src/features/<group>/<name>/`, where group is one
of `guild`, `user`, `bot`, `owner` (a closed set — see
[architecture.md](architecture.md#feature-groups)). Names are `kebab-case`
nouns: plural when the feature manages a collection (`tickets`, `reminders`),
singular for a singleton concern (`health`, `moderation`).

**Tests** live in `tests/`, mirroring `src/` exactly:
`src/platform/cache/memory.cache.ts` is tested by
`tests/platform/cache/memory.cache.test.ts`. Nothing under `src/` is a test.

### Banned filenames

`utils.ts` · `util.ts` · `helpers.ts` · `helper.ts` · `misc.ts` · `common.ts` ·
`types.ts` · `constants.ts` · `index.ts`

A name that does not say what the file is guarantees the file becomes whatever
is convenient. Barrel files (`index.ts`) additionally hide dependencies and
create cycles.

---

## Symbols

| Kind                   | Convention                      | Example                               |
| ---------------------- | ------------------------------- | ------------------------------------- |
| Class, type, interface | `PascalCase`, **no `I` prefix** | `TicketRepository`                    |
| Port implementation    | technology + role               | `PgTicketRepository`, `InMemoryCache` |
| Use case class         | verb phrase + `UseCase`         | `CloseTicketUseCase`                  |
| Error class            | `<Domain><Problem>Error`        | `TicketLimitExceededError`            |
| Function, variable     | `camelCase`                     | `findOpenTicket`                      |
| Module constant        | `SCREAMING_SNAKE_CASE`          | `MAX_OPEN_TICKETS`                    |
| Boolean                | `is` / `has` / `can` prefix     | `canClose`                            |
| Factory                | `create<Thing>`                 | `createPingCommand`                   |
| Type-only import       | `import type { … }`             | always                                |

---

## Everything else

| Thing           | Convention                                  | Example                         |
| --------------- | ------------------------------------------- | ------------------------------- |
| Table           | `snake_case`, plural                        | `tickets`, `guild_settings`     |
| Column          | `snake_case`; PK `id`; FK `<singular>_id`   | `closed_by_user_id`             |
| Timestamps      | `created_at`, `updated_at`, `<verb>ed_at`   | `closed_at`                     |
| Migration       | `NNNN_<verb>-<noun>.up.sql` (+ `.down.sql`) | `0001_create-tickets.up.sql`    |
| Cache namespace | `<feature>:<entity>`, declared by its owner | `tickets:open-count`            |
| Custom id       | `<feature>:<action>:<payload>`, ≤ 100 chars | `tickets:close:01H…`            |
| Error code      | `FEATURE_REASON`, permanent, enforced       | `TICKETS_LIMIT_EXCEEDED`        |
| Failure wording | built from `say.*`, never written inline    | `say.tooLong("A prefix", 8)`    |
| Placeholder     | `{name}` or `{group.name}`, in a catalogue  | `{user.name}`, `{server.count}` |
| Env var         | `SCREAMING_SNAKE`, domain-prefixed          | `DISCORD_TOKEN`                 |
| Metric          | `bot_<subsystem>_<name>_<unit>`             | `bot_command_ack_duration_ms`   |
| Job id          | `<feature>.<verb>-<noun>`                   | `tickets.expire-stale`          |
| Command name    | spoken form, space-separated                | `"ticket open"`                 |
| Commit          | Conventional Commits                        | `feat(tickets): add claim flow` |
| Branch          | `<type>/<short-description>`                | `feat/ticket-claiming`          |

---

## Wording

Everything the bot says is read next to everything else it says. Command
descriptions in particular appear in one list in Discord's picker, so drift
between them is visible to users long before it is visible in review.

Enforced by `tests/architecture/wording.test.ts` against the real registered
commands.

| Thing               | Shape                                     | Example                                        |
| ------------------- | ----------------------------------------- | ---------------------------------------------- |
| Command description | imperative, opens with an approved verb   | `Set the message new members are greeted with` |
| Option description  | noun phrase naming the value              | `The channel new members are greeted in`       |
| Failure wording     | built from `say.*`                        | `say.tooLong("A prefix", 8)`                   |
| Outcome text        | one sentence, capital to full stop        | `Set the **welcome message**.`                 |
| Bold                | the operative noun, not the sentence      | `Set the **prefix** to: …`                     |
| Backticks           | the value, not the label                  | ``Set the **prefix** to: `?` ``                |
| Settings row        | `> -# **Label:** value`, `n/a` when unset | `> -# **Channel:** #general`                   |
| Cache namespace     | declared beside the read, owner and TTL   | `guild:welcome`                                |
| Cooldown            | only when the cost lands on someone else  | `/welcome test` posts to a channel             |

**What a reply looks like.** One glyph, one sentence, in an embed coloured by
what happened — no titles, no footers, no author rows. Success is green with a
tick, warning amber, failure red; neutral output gets neither glyph nor colour,
because it is a settings screen or an answer, not something that happened.
`sections` turn the same reply into a settings card, and are the only escape
hatch. The one thing that takes none of this is text a _user_ wrote — a welcome
greeting arrives exactly as they typed it.

- **Verbs are a closed list** — `Show`, `Set`, `Add`, `Remove`, `Reset`, `Open`,
  `Post`, … — kept in the test. `Show`, `View` and `Display` are three words for
  one idea; picking one is the difference between a command list and a
  thesaurus. Adding a verb is a deliberate edit to that file.
- **An option is a value, not an action.** `Set the channel…` on the option of a
  command already called `Set where the greeting is posted` says it twice.
- **No full stop, no `this command`, no repeating the command's own name.**
  Discord already shows the name on the line above.
- Descriptions are unique. Two commands described identically means one of them
  is describing the other.

---

## Imports

Order, with a blank line between groups (lint-enforced, auto-fixable):

```ts
import { readFile } from "node:fs/promises"; // 1. node builtins

import { z } from "zod"; // 2. external

import type { Cache } from "#platform/…"; // 3. aliases
import type { Response } from "#discord/…"; //    #app #platform #discord
//    #features #shared
import { TicketId } from "../domain/…"; // 4. parent
import { present } from "./ticket.presenter.js"; // 5. sibling
```

Relative imports **within** a feature; aliases **across** top-level directories.
Always include the `.js` extension — this is native ESM, and the extension is
part of the specifier even in TypeScript source.

---

## Size ceilings

Warnings, not errors. They are not about aesthetics: a file outgrowing its
ceiling is the earliest reliable signal that something belongs in another layer.

| Kind         | Soft cap  |
| ------------ | --------- |
| Use case     | 80 lines  |
| Command file | 150 lines |
| Any file     | 300 lines |

A use case pushing 80 lines almost always has a domain rule hiding in it. If a
file genuinely needs to be larger, say why in a comment at the top.

---

## Comments

Comment **why**, not what. The code already says what it does.

```ts
// BAD — restates the code
// Set the acknowledged flag to true
this.acknowledged = true;

// GOOD — explains a decision the code cannot
// Set synchronously, before the await: the defer timer and a finishing
// handler race, and whoever gets here first must win definitively.
this.acknowledged = true;
```

Worth a comment: a non-obvious constraint (Discord's 3-second budget), a
rejected alternative, a bug being prevented, a deliberate trade-off. Not worth
one: anything the signature already says.
