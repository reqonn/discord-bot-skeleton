# ADR-0006 — Features describe responses; the design system renders them

**Status:** accepted

## Context

The repository this project replaces states its goal as "consistent UI/UX from
the start". In a codebase where each feature builds its own embeds, consistency
depends on every author remembering a convention, and it degrades steadily.

## Decision

Handlers return a `Response` view model — `{ kind: "success", text, sections }`,
`{ kind: "error", error }`, `{ kind: "list", items, page }`. `src/discord/ui/`
is the only code that constructs an embed or a component.

## Why

Consistency becomes structural rather than behavioural. A feature _cannot_
render an error that looks unlike every other error, because it cannot render
anything.

Secondary benefits that turned out to matter as much:

- **Tests assert intent.** `expect(response.kind).toBe("warning")` rather than
  digging through embed fields. Rendering is tested once.
- **A visual change is one file.** Changing the error colour, adding a footer,
  restructuring pagination — none of it touches a feature.
- **Error disclosure is centralised.** Whether `detail` reaches a user is
  decided in the renderer, so no handler can leak internals by picking the wrong
  string.

## Consequences

- New visual affordances mean a new `Response` kind, which is a deliberate edit
  to a shared contract — the friction is the feature.
- Anything genuinely one-off has nowhere to live. So far that has not come up;
  if it does, the answer is a new kind, not an escape hatch.
