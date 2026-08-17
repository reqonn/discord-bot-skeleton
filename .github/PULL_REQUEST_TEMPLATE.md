# What changed

<!-- One or two sentences. What does this do that the codebase could not do before? -->

## Why

<!-- The problem this solves. Link an issue if there is one. -->

## Architecture checklist

Tick what applies. If you had to break a rule, say which one and why — the rules
are changeable, but only deliberately. See `docs/architecture.md`.

- [ ] No business logic was added to a command, event, or `main.ts`
- [ ] No `discord.js` import outside `src/discord/`
- [ ] No database access outside a repository implementation
- [ ] No `process.env` read outside `src/platform/config/`
- [ ] Use cases return `Result`; `throw` is reserved for programmer error
- [ ] New ports have both an implementation and a fake
- [ ] New commands declare `authorize` explicitly
- [ ] Filenames follow `docs/conventions.md`
- [ ] New abstractions have a second caller in sight, or were not added

## Testing

<!-- What did you test, and how? "pnpm verify passes" is necessary, not sufficient. -->

- [ ] `pnpm verify` passes
- [ ] Exercised in a real guild
