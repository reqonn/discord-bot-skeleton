import type { RequestContext } from "../../platform/context/request-context.js";
import type { Logger } from "../../platform/logging/logger.contract.js";
import { Metric } from "../../platform/metrics/metrics.catalog.js";
import type { Metrics } from "../../platform/metrics/metrics.contract.js";

/**
 * What is done with an outcome once the pipeline has one.
 *
 * Beside `pipeline.ts` rather than inside it, for the same reason
 * `failure-reporting.ts` is: the pipeline owns the *order* of a request and
 * stays the one place that does. Recording the outcome is what happens at the
 * end of that order, not part of it.
 *
 * The query count is the line worth reading. A command that issues fourteen
 * queries announces its N+1 here, long before it is slow enough to notice.
 */
export function recordCompletion(
  deps: { readonly metrics: Metrics; readonly logger: Logger },
  context: RequestContext,
  outcome: string,
): void {
  const durationMs = Date.now() - context.startedAt;
  const labels = { operation: context.operation, outcome };

  deps.metrics.increment(Metric.commandTotal, labels);
  deps.metrics.observe(Metric.commandAckDurationMs, durationMs, {
    operation: context.operation,
  });
  deps.metrics.observe(Metric.commandQueriesPerRequest, context.counters.queries, {
    operation: context.operation,
  });

  deps.logger.debug("Interaction complete", {
    durationMs,
    outcome,
    queries: context.counters.queries,
    queryMs: Math.round(context.counters.queryDurationMs),
    cacheHits: context.counters.cacheHits,
    cacheMisses: context.counters.cacheMisses,
  });
}
