# ADR-0004 — Raw SQL behind repository interfaces

**Status:** accepted

## Context

The usual reasons to adopt an ORM are portability, type safety, and migration
tooling. The usual costs are indirection on hot paths and surprising generated
SQL.

## Decision

`pg` with raw parameterized SQL, written inside repository implementations that
sit behind interfaces owned by the application layer. A hand-rolled migration
runner.

## Why

- **Portability is already provided by the ports.** The interface is what the
  application depends on; swapping databases means writing new implementations,
  which is exactly what an ORM's abstraction would also require.
- **The hot paths need exact SQL.** Interactions have a 3-second budget. Knowing
  precisely which query runs, and which index serves it, is worth more here than
  a query builder's convenience.
- **SQL is the thing being tested.** Hiding it behind a builder moves where the
  bugs live without removing them.
- **Type safety is recovered at the boundary** with typed generics on `query<T>`
  plus integration tests against a real database.

## Consequences

- Repositories are integration-tested against real PostgreSQL. Mocking `pg`
  proves nothing and is banned.
- Migrations are plain SQL, applied under an advisory lock, checksummed so an
  edited migration is a startup failure.
- If the schema grows past what handwritten SQL comfortably serves, revisit —
  the ports mean that revisit is contained.
