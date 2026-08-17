# ADR-0001 — Feature slices over global horizontal layers

**Status:** accepted

## Context

The conventional clean-architecture layout puts `domain/`, `application/`,
`infrastructure/`, and `presentation/` at the top level, with every feature
spread across all four. It is instantly recognisable, and the dependency
direction is visible from the root directory. This bot is expected to grow to
dozens of features.

## Decision

Vertical feature slices, each internally layered exactly as clean architecture
prescribes. A shared `platform/` provides infrastructure primitives.

## Why

The horizontal layout has two costs that grow with feature count:

- **Change locality.** Adding one feature edits four distant directories.
  Reviewing it means holding four open.
- **Directory scale.** `application/use-cases/` becomes a flat list of two
  hundred files whose only grouping is alphabetical.

There is a third, subtler cost: a global `domain/` invites an anaemic one. A lot
of Discord bot work is orchestration, and when the domain layer is a shared
directory rather than a feature's own, the pressure is to put everything in
`application/` and leave `domain/` full of DTOs.

Slices keep a feature's rules next to the code that uses them, and make a
feature deletable by deleting its directory.

## Consequences

- The same dependency rules apply, read vertically. Nothing is relaxed.
- "Where does this go?" is answered by feature first, layer second.
- Cross-feature coupling needs an explicit mechanism, because it can no longer
  happen by accident through a shared layer directory.
