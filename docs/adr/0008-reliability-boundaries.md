# ADR-0008 — Outbound governor and query retry

**Status:** accepted

## Context

Two failures reliably take a Discord bot down, and neither is a bug in the bot:

1. **A transient database failure.** A failover, a connection reset, a
   connection-pool exhaustion. Without retry, every interaction in flight during
   the blip is lost, and users see an error for something that was working a
   second earlier and will work a second later.
2. **Rate-limit exhaustion.** One guild — usually mid-raid — generates enough
   outbound calls to consume the bot's allowance. Discord's 429s then apply to
   _every_ guild the bot is in, so one server's problem becomes everyone's.

Both are cheap to handle at the boundary and expensive to retrofit: the second
in particular means finding and wrapping every outbound call site in a grown
codebase.

## Decision

**Query retry**, driven by a pure decision function that classifies the failure
and the statement. Connection failures retry unconditionally; transient server
errors retry only for reads outside a transaction; statement timeouts and
deterministic errors never retry. Total retry time is bounded below the Discord
acknowledgement window.

**An outbound governor** — per-guild rolling budget, per-guild-and-feature
circuit breaker, priority queue, concurrency cap — that every outbound Discord
call passes through. It returns `Result`, not `null`. Interaction replies are
excluded.

## Why these shapes

**Retry keyed on "did it run?", not "did it fail?".** A connection that was
never established carried nothing, so retrying is free even for a mutation. A
statement that reached the server and failed may have applied — retrying it is
how you get two of something. That single distinction is the whole policy.

**A deadline below the ack window.** Retrying is only worth doing if the answer
still arrives in time. A retry that succeeds after the user has already seen
"the application did not respond" has made things worse, not better.

**Per-guild, not global, budgets.** Isolating the blast radius is the entire
point. A global counter would spread one server's burst across all of them.

**Breaker keyed on guild _and_ feature.** "The bot lost permissions here"
(every feature fails in one guild) and "this feature calls a broken endpoint"
(one feature fails everywhere) are different failures with different responses.
A single breaker would trip on neither in time.

**One probe on recovery.** Admitting everything the moment the cooldown expires
re-floods a dependency exactly as it starts to recover.

**`Result`, not `null`.** v1 of this idea returned `null` on drop and needed a
written rule reminding callers not to treat that as success. A `Result` makes
the compiler enforce what the rule was asking for.

**Interaction replies excluded.** They use the interaction token, which Discord
rate-limits separately from guild and channel routes. Budgeting them against a
per-guild allowance models the wrong thing, and putting a queue on the
latency-critical path risks the 3-second window for nothing.

## Consequences

- The governor is the **only speculative component in the codebase** — it has no
  caller until a feature sends its first message. That is a knowing exception to
  RULE 11, made because the retrofit cost is the whole argument, and it is
  documented as an exception rather than quietly justified.
- Feature `infrastructure/` may import `discord/gateway/`, narrower than all of
  `src/discord/`. discord.js stays banned there regardless, so an adapter must
  still go through the gateway to actually call Discord.
- Retry makes a failing query slower before it fails. The deadline caps that,
  and the retry counter is a metric, so the cost is visible.
- Neither has been exercised against a real outage. The decision tables are
  unit-tested exhaustively; the behaviour under a genuine Discord degradation is
  not yet proven, and should not be assumed.
