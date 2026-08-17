# ADR-0007 — Environments differ by wiring, not by branching

**Status:** accepted

## Context

Development must run without Redis; production requires it. The obvious
implementation is `if (config.redis.enabled)` wherever caching or locking
happens.

## Decision

`Cache` and `Lock` are ports. `src/app/wiring.ts` — one file — chooses
`MemoryCache`/`LocalLock` or `TieredCache`/`RedisLock`. No other file reads the
environment.

## Why

Scattered environment checks create code paths that production runs and
development never exercises, and vice versa. Those paths are where bugs live,
because neither the tests nor the developer ever sees them.

With wiring, **development exercises the same code paths production runs.** The
only difference is which object was constructed at startup.

## Consequences

- Adding an environment-dependent implementation means adding a port, not an
  `if`.
- `LocalLock` never loses its lease, so code written against it can still be
  wrong under `RedisLock`. This is a real hazard, and the reason a job handler
  must honour the abort signal even when the local lock will never raise it.
- Degradations are printed at startup, so nobody discovers them from behaviour.
  Running production without Redis is permitted — a single-instance bot does not
  need it — but the warning names the constraint in capitals, because the thing
  that breaks it is someone raising the replica count months later.
