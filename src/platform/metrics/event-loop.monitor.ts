import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

import type { Logger } from "../logging/logger.contract.js";

import { Metric } from "./metrics.catalog.js";
import type { Metrics } from "./metrics.contract.js";

const SAMPLE_INTERVAL_MS = 10_000;
const RESOLUTION_MS = 10;

/**
 * Watches event loop delay and publishes it as gauges.
 *
 * Worth its own subsystem because a blocked event loop is the failure mode that
 * is hardest to diagnose from the outside: commands time out, Discord looks
 * slow, the database looks fine, and nothing in the application logs is wrong.
 * A p99 delay gauge turns that into a one-glance answer.
 *
 * The histogram is reset after each sample, so gauges describe the last window
 * rather than all time — a spike an hour ago should not still be showing.
 */
export class EventLoopMonitor {
  private readonly histogram: IntervalHistogram;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly metrics: Metrics,
    private readonly logger: Logger,
    /** p99 above this logs a warning. Chosen well below the Discord ack budget. */
    private readonly warnThresholdMs = 100,
  ) {
    this.histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.histogram.enable();

    // Publish immediately so /metrics is never empty for the first sampling
    // window — an empty scrape reads as "the endpoint is broken".
    this.sample();

    this.timer = setInterval(() => {
      this.sample();
    }, SAMPLE_INTERVAL_MS);

    // Monitoring must never be the reason the process stays alive.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.histogram.disable();
  }

  /** Exposed for tests and for a final sample during shutdown. */
  sample(): void {
    const toMs = (nanoseconds: number): number => Math.round(nanoseconds / 1_000_000);

    const p50 = toMs(this.histogram.percentile(50));
    const p99 = toMs(this.histogram.percentile(99));
    const max = toMs(this.histogram.max);

    this.metrics.setGauge(Metric.eventLoopDelayMs, p50, { quantile: "p50" });
    this.metrics.setGauge(Metric.eventLoopDelayMs, p99, { quantile: "p99" });
    this.metrics.setGauge(Metric.eventLoopDelayMs, max, { quantile: "max" });
    this.metrics.setGauge(Metric.processUptimeSeconds, Math.round(process.uptime()));

    if (p99 > this.warnThresholdMs) {
      this.logger.warn("Event loop delay is high", {
        p50,
        p99,
        max,
        thresholdMs: this.warnThresholdMs,
        hint: "Something CPU-bound is running on the main loop. Move it to a job or a worker thread.",
      });
    }

    this.histogram.reset();
  }
}
