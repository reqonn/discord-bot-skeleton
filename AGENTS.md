# AGENTS.md

Instructions for AI coding agents working in this repository.
Human contributors: read [CONTRIBUTING.md](CONTRIBUTING.md) instead.

This file is read automatically by Cursor, GitHub Copilot, Claude Code, Codex,
Zed, and most other agents. Keep it short — it is loaded into every context.

---

## The rule that matters most

**Run `pnpm verify` before you say you are done.** It runs typecheck, lint,
architecture rules, and the full test suite — the same thing CI runs.

If it fails, **fix the code**. The harness is the specification.

---

## Never do these

These are the failure modes that turn a clean codebase into a tangled one, and
they are the ones an agent is most likely to reach for when blocked:

- **Never weaken a check to make a change pass.** Do not disable, relax, or
  delete a lint rule, a dependency-cruiser rule, or a test. If you believe a
  rule is genuinely wrong, stop and say so — do not route around it.
- **Never suppress without explaining.** `// eslint-disable-next-line <rule> --
<why, and when this can go>`. A bare suppression is not acceptable.
- **Never use `any`, `as unknown as`, or `@ts-expect-error`** to get past a type
  error. The type is telling you something.
- **Never import `discord.js` outside `src/discord/`.**
- **Never read `process.env` outside `src/platform/config/`.**
- **Never create `utils.ts`, `helpers.ts`, `index.ts`, or `types.ts`.**
- **Never put a test in `src/`.** Tests live in `tests/`, mirroring `src/`.
- **Never add a dependency** without saying why in your message.
- **Never write a second way to do something the pipeline already does** —
  parsing a message, replying, checking a permission, rendering an embed. If it
  feels like plumbing, it already exists; find it rather than adding a rival.
- **Never stringify an error to log it.** Pass it whole — `logger.warn("could
not renew the lease", { error })`. The port serialises it at every level, with
  its cause chain, and scrubs credentials out of the message. `String(error)`
  throws that away and can put a password in the log.

---

## Where things go

```
src/                      shipped code only — no tests, no fakes
├── main.ts               entry: signals and fatal errors, no logic
├── app/                  composition root — the only place that wires
├── platform/             infrastructure behind ports (db, cache, jobs, …)
├── discord/              the ONLY discord.js code
│   ├── contracts/          what features are allowed to know
│   ├── kernel/             pipeline, registry, deferral
│   ├── ui/                 the only code that builds an embed
│   └── gateway/            outbound rate governor
├── features/<group>/<name>/
│   ├── api/                Discord adapter — no discord.js
│   ├── application/        use cases + ports/
│   ├── domain/             rules — depends on nothing
│   └── infrastructure/     port implementations
└── shared/               Result, errors, types — zero dependencies

tests/                    mirrors src/, plus support/ and architecture/
```

Feature groups are a closed set: **`guild`** (per-server), **`user`**
(per-person), **`bot`** (about the bot itself), **`owner`** (owner-only).

---

## Adding a command

```bash
pnpm new:feature <group> <name>    # scaffolds api/ and application/
```

1. Write the use case in `application/`. Return `Result<T, AppError>` — do not
   throw for a failure the caller is meant to handle.
2. Declare the command in `api/` with `defineCommand`: `input` schema,
   `authorize`, optional `cooldown`.
3. Map the result to a `Response`. **Do not build an embed.**
4. Add it to the feature's `commands`, then one line in `src/app/features.ts`.
5. `pnpm verify`.

You get `/name` **and** `!name` from that. Message commands run the same
descriptor through the same pipeline — there is nothing extra to write, and
writing a message handler of your own is the mistake this prevents.

**Put what the user reads in `<name>.presenter.ts`**, not in the command. Every
file in `api/` must be one of `.command.ts`, `.component.ts`, `.modal.ts`,
`.event.ts`, `.job.ts` or `.presenter.ts` — a test enforces the list, so `ui.ts`
or `embeds.ts` will fail. A command reads as: authorize, call the use case,
present. See `src/features/guild/prefix/api/`.

**Build failure messages from `#shared/errors/phrasing.js`**, never as inline
prose. `say.tooLong("A prefix", 8)` rather than a sentence you wrote — so two
features reject the same thing the same way. Error codes are
`FEATURE_REASON`, permanent, and declared in the feature's `domain/*.errors.ts`.
Both are enforced.

**For messages a user authors**, use `#shared/text/template.js` with a catalogue
— `MEMBER_PLACEHOLDERS` covers `{user} {user.name} {user.id} {user.created}
{server} {server.id} {server.count} {server.ordinal} {channel}`. Never write
your own substitution: one catalogue drives both rendering and typo detection,
so adding a placeholder does both at once. Catalogues stay **synchronous** —
anything needing an API call is resolved in `api/` and passed in as context,
never added to the catalogue.

**Command descriptions are checked**, in `tests/architecture/wording.test.ts`.
A command description is imperative and opens with a verb from the list there
("Set the message new members are greeted with"); an option description names
the value and does not ("The channel new members are greeted in"). Neither ends
in a full stop.

**A reply is one glyph and one sentence** — `Set the **welcome message**.` —
rendered as an embed. `success` is green with a tick, `warning` amber, an error
red; `info` is the **default frame** with no glyph and no colour, and is what a
settings card or an answer to a question takes. Bold the operative noun,
backtick the value, end the sentence. `sections` is the only escape hatch;
there is no title, footer, or second paragraph to put anything in.

**Errors are sentences as well.** Compose them from `say.*` — a fragment handed
to an error constructor ships to a user as `⛔ set a message and a channel`, and
`tests/architecture/wording.test.ts` fails on it. See docs/conventions.md.

**A cooldown is for a command whose cost lands on somebody else** — it posts a
message, sends a DM, calls a paid API. Not for a cheap read. Exactly one
command in this repository has one.

Add `domain/` only when there is a rule worth protecting, and
`infrastructure/` only when there is state to store. Do not create empty
_layer_ directories for symmetry — their presence is information.

(The four group directories are the exception: they exist from the start with a
`.gitkeep`, because the taxonomy is fixed and worth seeing.)

---

## The five rules you will meet

Full list with examples: [docs/architecture.md § 4](docs/architecture.md#4-the-rules).

1. **discord.js only in `src/discord/`.** Features use `#discord/contracts`.
2. **Features return `Response`, never embeds.** `src/discord/ui/` renders.
3. **Use cases depend on ports, not implementations.**
4. **Expected failures are `Result` values; `throw` is for bugs.**
5. **`process.env` only in `src/platform/config/`.**

---

## When a rule blocks you

This is the moment the codebase is most likely to be damaged, so it has its own
instruction: **the rule is probably right and the design is probably wrong.**

Work through it in this order.

1. **Read the failure.** Every check names the rule it protects and points at
   `docs/architecture.md`. The message usually contains the fix.
2. **Ask what the rule is protecting.** "I need `discord.js` in a use case"
   almost always means the use case wants an id it was never given — add it to
   the port, not the import.
3. **If you still think the rule is wrong, stop and say so**, with the specific
   case. Do not suppress, do not widen a glob, do not add `any`. A rule that
   deserves to change is changed deliberately
   ([§ 15](docs/architecture.md#15-changing-a-rule)) — never as a side effect of
   getting something to pass.

---

## Done means

- [ ] `pnpm verify` passes — you ran it, you did not assume it
- [ ] You did not weaken any check
- [ ] New commands declare `authorize` explicitly
- [ ] New ports have a fake — in the test that needs it, or in `tests/support/`
      once a second test does
- [ ] New env vars are in the schema _and_ `.env.example` (a test checks both)
- [ ] Comments explain **why**, not what
