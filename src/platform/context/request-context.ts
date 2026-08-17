import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import type { Snowflake } from "../../shared/types/snowflake.types.js";

/**
 * Per-request counters, filled in by infrastructure as the request runs.
 *
 * Mutable on purpose. The database layer increments `queries` without knowing
 * who is asking, which is what lets the pipeline log "this command issued 14
 * queries" and make an N+1 announce itself instead of hiding. See
 * docs/architecture.md § Performance.
 */
export interface RequestCounters {
  queries: number;
  queryDurationMs: number;
  cacheHits: number;
  cacheMisses: number;
}

/**
 * Ambient context for one interaction, event, or job run.
 *
 * Carried in an AsyncLocalStorage rather than threaded through every signature,
 * so a use case five calls deep does not take a `correlationId` parameter it
 * never reads. The logger reads this automatically — no call site passes it.
 */
export interface RequestContext {
  readonly correlationId: string;
  readonly source: "command" | "component" | "autocomplete" | "event" | "job";
  /** What ran: the command name, component scope, event, or job id.
   *  Called `operation` rather than `name` because `name` is how pino renders
   *  a logger label, and the collision makes pretty-printed logs misleading. */
  readonly operation: string;
  readonly guildId: Snowflake | undefined;
  readonly userId: Snowflake | undefined;
  readonly startedAt: number;
  readonly counters: RequestCounters;
}

export interface RequestContextSeed {
  readonly source: RequestContext["source"];
  readonly operation: string;
  readonly guildId?: Snowflake | undefined;
  readonly userId?: Snowflake | undefined;
  readonly correlationId?: string | undefined;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Twelve hex characters: short enough to read in a pretty-printed dev log,
 * wide enough that a collision within a support conversation is not a concern.
 */
export function createCorrelationId(): string {
  return randomBytes(6).toString("hex");
}

export function createRequestContext(seed: RequestContextSeed, now: number): RequestContext {
  return {
    correlationId: seed.correlationId ?? createCorrelationId(),
    source: seed.source,
    operation: seed.operation,
    guildId: seed.guildId,
    userId: seed.userId,
    startedAt: now,
    counters: { queries: 0, queryDurationMs: 0, cacheHits: 0, cacheMisses: 0 },
  };
}

/** Runs `fn` with `context` visible to everything it awaits. */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * The active context, or undefined outside a request — during startup, for
 * instance. Callers must tolerate undefined rather than assert.
 */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Records a completed database query against the active request, if any.
 * A no-op outside a request, so infrastructure never needs to check.
 */
export function recordQuery(durationMs: number): void {
  const context = storage.getStore();
  if (context === undefined) return;
  context.counters.queries += 1;
  context.counters.queryDurationMs += durationMs;
}

export function recordCacheHit(): void {
  const context = storage.getStore();
  if (context !== undefined) context.counters.cacheHits += 1;
}

export function recordCacheMiss(): void {
  const context = storage.getStore();
  if (context !== undefined) context.counters.cacheMisses += 1;
}
