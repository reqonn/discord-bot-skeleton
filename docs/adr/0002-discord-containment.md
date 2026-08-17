# ADR-0002 — discord.js confined to one directory

**Status:** accepted

## Context

The usual approach is "keep business logic away from discord.js" as a guideline,
with command handlers receiving `ChatInputCommandInteraction` directly. In
practice a handler reaches through the interaction for a member, a channel, a
guild — and the library ends up woven through the codebase.

## Decision

`discord.js` is import-banned outside `src/discord/`, enforced by ESLint with no
exceptions. Feature code — including its Discord-facing adapter — talks to
`CommandContext`, `Response`, and the other contracts in
`src/discord/contracts/`.

## Why

Three concrete benefits, in order of how often they matter:

1. **Tests need no mocking.** A handler is called with a plain object. Mocking
   `ChatInputCommandInteraction` well enough to be meaningful is a project in
   itself, and mocking it badly produces tests that pass while the code is wrong.
2. **The library becomes upgradable.** A breaking change is a change to one
   directory.
3. **The surface stays deliberate.** Adding a capability means editing the
   contract, which forces the question of whether it is really needed.

## Consequences

- Anything a feature needs from Discord must be modelled first. This is the
  cost, and it is paid repeatedly.
- Scripts are not exempt: `deploy-commands.ts` calls into
  `src/discord/kernel/command-deployer.ts` rather than importing REST itself. A
  rule with one exception becomes a rule with five.
- The contracts directory must not grow casually — a `CommandContext` that
  exposes everything is the original problem with extra steps.
