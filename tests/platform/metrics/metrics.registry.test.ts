import { describe, expect, it } from "vitest";

import type { MetricDefinition } from "#platform/metrics/metrics.contract.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

const requests: MetricDefinition = {
  name: "bot_test_requests_total",
  kind: "counter",
  help: "Requests handled.",
};

const connections: MetricDefinition = {
  name: "bot_test_connections",
  kind: "gauge",
  help: "Open connections.",
};

const latency: MetricDefinition = {
  name: "bot_test_latency_ms",
  kind: "histogram",
  help: "Handler latency.",
  buckets: [10, 100],
};

describe("MetricsRegistry", () => {
  describe("counters", () => {
    it("accumulates and renders", () => {
      const metrics = new MetricsRegistry();
      metrics.increment(requests);
      metrics.increment(requests, {}, 4);

      expect(metrics.render()).toContain("bot_test_requests_total 5");
    });

    it("keeps label sets as separate series", () => {
      const metrics = new MetricsRegistry();
      metrics.increment(requests, { outcome: "ok" });
      metrics.increment(requests, { outcome: "ok" });
      metrics.increment(requests, { outcome: "failed" });

      const output = metrics.render();
      expect(output).toContain('bot_test_requests_total{outcome="ok"} 2');
      expect(output).toContain('bot_test_requests_total{outcome="failed"} 1');
    });

    it("treats label order as insignificant", () => {
      const metrics = new MetricsRegistry();
      metrics.increment(requests, { a: "1", b: "2" });
      metrics.increment(requests, { b: "2", a: "1" });

      expect(metrics.render()).toContain('bot_test_requests_total{a="1",b="2"} 2');
    });

    it("includes help and type headers", () => {
      const metrics = new MetricsRegistry();
      metrics.increment(requests);

      const output = metrics.render();
      expect(output).toContain("# HELP bot_test_requests_total Requests handled.");
      expect(output).toContain("# TYPE bot_test_requests_total counter");
    });
  });

  describe("gauges", () => {
    it("replaces rather than accumulates", () => {
      const metrics = new MetricsRegistry();
      metrics.setGauge(connections, 7);
      metrics.setGauge(connections, 3);

      expect(metrics.render()).toContain("bot_test_connections 3");
    });
  });

  describe("histograms", () => {
    it("renders cumulative buckets, sum, and count", () => {
      const metrics = new MetricsRegistry();
      metrics.observe(latency, 5);
      metrics.observe(latency, 50);
      metrics.observe(latency, 5_000);

      const output = metrics.render();
      // Cumulative: 5 lands in le=10, le=100 and +Inf; 50 in le=100 and +Inf.
      expect(output).toContain('bot_test_latency_ms_bucket{le="10"} 1');
      expect(output).toContain('bot_test_latency_ms_bucket{le="100"} 2');
      expect(output).toContain('bot_test_latency_ms_bucket{le="+Inf"} 3');
      expect(output).toContain("bot_test_latency_ms_sum 5055");
      expect(output).toContain("bot_test_latency_ms_count 3");
    });

    it("counts a value exactly on a boundary as inside it", () => {
      const metrics = new MetricsRegistry();
      metrics.observe(latency, 10);

      expect(metrics.render()).toContain('bot_test_latency_ms_bucket{le="10"} 1');
    });

    it("keeps buckets per label set", () => {
      const metrics = new MetricsRegistry();
      metrics.observe(latency, 5, { command: "ping" });
      metrics.observe(latency, 500, { command: "ticket" });

      const output = metrics.render();
      expect(output).toContain('bot_test_latency_ms_bucket{command="ping",le="10"} 1');
      expect(output).toContain('bot_test_latency_ms_bucket{command="ticket",le="10"} 0');
    });
  });

  describe("kind safety", () => {
    it("refuses to observe into a counter", () => {
      const metrics = new MetricsRegistry();

      expect(() => metrics.observe(requests, 1)).toThrow(/cannot be used as a histogram/);
    });

    it("refuses to increment a gauge", () => {
      const metrics = new MetricsRegistry();

      expect(() => metrics.increment(connections)).toThrow(/cannot be used as a counter/);
    });
  });

  it("escapes label values so output stays parseable", () => {
    const metrics = new MetricsRegistry();
    metrics.increment(requests, { note: 'has "quotes"' });

    expect(metrics.render()).toContain('note="has \\"quotes\\""');
  });

  it("ends with a newline, as the exposition format requires", () => {
    const metrics = new MetricsRegistry();
    metrics.increment(requests);

    expect(metrics.render().endsWith("\n")).toBe(true);
  });
});
