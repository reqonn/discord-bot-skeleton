# Gates

Every file in `tests/architecture/` is a gate: a rule the build enforces rather
than one somebody has to remember. Each opens with the defect that caused it —
when one fails, read that before changing anything. It is usually telling you
the change is wrong, not the gate. This page is the index; `gates-documented`
keeps it complete in both directions.

Run them with `pnpm test tests/architecture`, or as part of `pnpm verify`.

## Structure

| Gate              | Holds                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `boundaries`      | The layering rules, asserted against the source itself so a lint rule switched off in a config file still fails a test named after the rule. |
| `configuration`   | The config schema and `.env.example` agree, in both directions.                                                                              |
| `documentation`   | Every path the docs mention exists, and the agent instructions still say the things that make them work.                                     |
| `node-version`    | `.nvmrc`, `engines.node`, `@types/node` and the Node actually running the suite all name the same major.                                     |
| `package-scripts` | Every `pnpm <script>` points at a file that exists, no script name is one pnpm runs itself, and production `start` does not read a `.env`.   |

## Failures

| Gate              | Holds                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `background-work` | Work nobody waits for ends in a handler — no bare `void` promise, which stops the process when it rejects. Use `detach`.                 |
| `refusal-wording` | No sentence the bot says is a bare "Please try again": a refusal names what to change, a fault shows an incident code, a wait says when. |

## Wired but never called

| Gate           | Holds                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dead-exports` | Nothing is exported that nothing refers to, and no domain rule is applied only by its own test. The defect shape that ships most often: exists, compiles, tested, called by nothing. |

## What the bot says

| Gate      | Holds                                                                                                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `wording` | Command and option descriptions, presenter copy and failure sentences follow one voice, checked against the real registry. |

## The index itself

| Gate               | Holds                                                    |
| ------------------ | -------------------------------------------------------- |
| `gates-documented` | This page lists every gate, and nothing that is not one. |
