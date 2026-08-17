# ADR-0005 — Result for expected failures

**Status:** accepted

## Context

A use case fails in two distinct ways: the request was valid and the answer is
"no" (limit reached, not found, not permitted), or something broke. Using
exceptions for both makes them indistinguishable at the call site.

## Decision

Use cases return `Result<T, AppError>`. `throw` is reserved for programmer error
and genuinely exceptional infrastructure failure.

## Why

- **The compiler enforces handling.** `result.value` is unreachable without
  narrowing `result.ok`. A caller cannot forget the failure branch.
- **The signature is honest.** `Promise<Result<Ticket, AppError>>` says this can
  fail; `Promise<Ticket>` says it cannot, and is usually lying.
- **Expected failures stop polluting error logs.** They are values, so they are
  logged at `info` and the error level stays meaningful.

## Consequences

- Use cases return `Result`; adapters narrow it and map to a `Response`.
- The pipeline still catches throws and renders them, so a bug produces a safe
  reply rather than a silent timeout.
- `AppError` carries `severity`, which decides log level and whether `detail`
  reaches the user.
