# ADR-0003 — A composition root, not a DI framework

**Status:** accepted

## Context

The codebase needs explicit dependencies and testable units. The usual options
are a container library (inversify, tsyringe) with decorators and reflection, or
hand-written wiring.

## Decision

Hand-written composition in `src/app/`. Constructor injection everywhere. No
decorators, no reflection, no container library.

Each feature exports a factory taking exactly what it needs:
`createHealthFeature({ database, cache, cacheTier })`.

## Why

A DI framework's selling point is auto-wiring — and auto-wiring is precisely
what makes a large codebase hard to reason about. "Where does this instance come
from?" stops having a greppable answer.

Hand-written wiring gives:

- every dependency visible and type-checked at the point of construction
- startup order that is explicit rather than emergent
- no framework semantics for a new contributor to learn
- tests that construct exactly what they need, with no container setup

The cost is a file that grows with the feature count. That file is also a useful
map of the system.

## Consequences

- A feature's dependencies are readable from its factory signature.
- If `app/` exceeds ~200 lines, split it per-feature — do not add a framework.
- Features depend on the _type_ of what they need, never on a container.
