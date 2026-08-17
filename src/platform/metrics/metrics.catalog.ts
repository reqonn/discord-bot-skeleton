import type { MetricDefinition } from "./metrics.contract.js";

/**
 * Every metric this bot exposes.
 *
 * Naming: `bot_<subsystem>_<name>_<unit>` (docs/conventions.md). The `bot_`
 * prefix is a Prometheus namespace — rename it to your bot's name with one
 * find-and-replace in this file, which is the only place metric names exist.
 *
 * Declared in
 * one file so the exposed surface is reviewable in a single screen, and so two
 * subsystems cannot invent two spellings of the same measurement.
 *
 * Bucket choices are set by the Discord interaction budget: acknowledging
 * inside 3 s is the hard constraint, so the buckets crowd around the range
 * where the answer changes from "fine" to "about to lose the interaction".
 */

const ACK_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 1_500, 2_500, 3_000] as const;
const IO_BUCKETS_MS = [1, 5, 10, 25, 50, 100, 250, 500, 1_000, 2_500] as const;

function counter(name: string, help: string): MetricDefinition {
  return { name, kind: "counter", help };
}

function gauge(name: string, help: string): MetricDefinition {
  return { name, kind: "gauge", help };
}

function histogram(name: string, help: string, buckets: readonly number[]): MetricDefinition {
  return { name, kind: "histogram", help, buckets };
}

export const Metric = {
  // ── Interaction pipeline ───────────────────────────────────────────────────
  commandAckDurationMs: histogram(
    "bot_command_ack_duration_ms",
    "Time from receiving an interaction to acknowledging it. The number that must stay under 3000.",
    ACK_BUCKETS_MS,
  ),
  commandHandlerDurationMs: histogram(
    "bot_command_handler_duration_ms",
    "Time spent inside the use case, excluding pipeline overhead.",
    ACK_BUCKETS_MS,
  ),
  commandTotal: counter(
    "bot_command_total",
    "Commands handled, labelled by command and outcome (ok, expected_error, unexpected_error).",
  ),
  commandDeferredTotal: counter(
    "bot_command_deferred_total",
    "Commands where the adaptive defer timer fired before the handler finished.",
  ),
  commandQueriesPerRequest: histogram(
    "bot_command_queries_per_request",
    "Database queries issued per interaction. A rising tail is an N+1 announcing itself.",
    [0, 1, 2, 3, 5, 8, 13, 21, 50],
  ),

  // ── Database ───────────────────────────────────────────────────────────────
  databaseQueryDurationMs: histogram(
    "bot_database_query_duration_ms",
    "Duration of a single database query.",
    IO_BUCKETS_MS,
  ),
  databaseQueryTotal: counter(
    "bot_database_query_total",
    "Database queries executed, labelled by outcome.",
  ),
  databaseQueryRetryTotal: counter(
    "bot_database_query_retry_total",
    "Query attempts retried, labelled by the driver code that caused it. A rising count is a database or network problem, not an application one.",
  ),
  databasePoolConnections: gauge(
    "bot_database_pool_connections",
    "Connections in the pool, labelled by state (total, idle, waiting).",
  ),

  // ── Cache ──────────────────────────────────────────────────────────────────
  cacheOperationTotal: counter(
    "bot_cache_operation_total",
    "Cache reads, labelled by tier and outcome (hit, miss).",
  ),

  // ── Discord API ────────────────────────────────────────────────────────────
  discordActionTotal: counter(
    "bot_discord_action_total",
    "Outbound Discord API actions, labelled by outcome (sent, queued, dropped, failed).",
  ),

  discordActionQueueDepth: gauge(
    "bot_discord_action_queue_depth",
    "Outbound Discord actions waiting across all guilds. Sustained depth means the budget is too tight or something is generating more work than Discord will accept.",
  ),
  discordCircuitsOpen: gauge(
    "bot_discord_circuits_open",
    "Guild-and-feature circuits currently refusing calls. Non-zero means the bot has stopped hammering something that was failing.",
  ),

  // ── Jobs ───────────────────────────────────────────────────────────────────
  jobRunTotal: counter("bot_job_run_total", "Job executions, labelled by job and outcome."),
  jobDurationMs: histogram(
    "bot_job_duration_ms",
    "Job execution time.",
    [10, 50, 100, 500, 1_000, 5_000, 30_000],
  ),

  // ── Process health ─────────────────────────────────────────────────────────
  eventLoopDelayMs: gauge(
    "bot_event_loop_delay_ms",
    "Event loop delay, labelled by quantile. A blocked loop presents to users as 'Discord is slow' and is otherwise near-invisible.",
  ),
  processUptimeSeconds: gauge("bot_process_uptime_seconds", "Seconds since the process started."),
} as const satisfies Record<string, MetricDefinition>;
