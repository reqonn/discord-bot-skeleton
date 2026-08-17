import type { MetricDefinition, MetricLabels, Metrics, MetricKind } from "./metrics.contract.js";

interface Series {
  readonly definition: MetricDefinition;
  /** Keyed by the rendered label set, so one metric holds many label combinations. */
  readonly points: Map<string, Point>;
}

interface Point {
  readonly labels: MetricLabels;
  value: number;
  /** Histograms only: counts per bucket, aligned with `definition.buckets`, plus +Inf. */
  bucketCounts?: number[];
  sum?: number;
  count?: number;
}

/**
 * A small Prometheus-compatible registry.
 *
 * Written rather than pulled in because the requirement is narrow — a handful
 * of declared series, scraped from one endpoint — and a client library would
 * bring a registry abstraction, a default-metrics collector, and a clustering
 * story none of which this process wants. Roughly 150 lines against a
 * dependency is the right trade here; if the requirement grows past label
 * cardinality management, revisit it. (ADR-0008.)
 */
export class MetricsRegistry implements Metrics {
  private readonly series = new Map<string, Series>();

  increment(metric: MetricDefinition, labels: MetricLabels = {}, by = 1): void {
    assertKind(metric, "counter");
    const point = this.pointFor(metric, labels);
    point.value += by;
  }

  setGauge(metric: MetricDefinition, value: number, labels: MetricLabels = {}): void {
    assertKind(metric, "gauge");
    this.pointFor(metric, labels).value = value;
  }

  observe(metric: MetricDefinition, value: number, labels: MetricLabels = {}): void {
    assertKind(metric, "histogram");
    const buckets = metric.buckets ?? [];
    const point = this.pointFor(metric, labels);

    point.bucketCounts ??= new Array<number>(buckets.length + 1).fill(0);
    point.sum = (point.sum ?? 0) + value;
    point.count = (point.count ?? 0) + 1;

    // Prometheus buckets are cumulative: an observation lands in its own bucket
    // and every wider one, so a scraper can compute quantiles by subtraction.
    for (let i = 0; i < buckets.length; i += 1) {
      if (value <= (buckets[i] ?? Number.POSITIVE_INFINITY)) {
        point.bucketCounts[i] = (point.bucketCounts[i] ?? 0) + 1;
      }
    }
    const overflow = buckets.length;
    point.bucketCounts[overflow] = (point.bucketCounts[overflow] ?? 0) + 1;
  }

  render(): string {
    const blocks: string[] = [];

    for (const series of this.series.values()) {
      const { definition, points } = series;
      blocks.push(`# HELP ${definition.name} ${definition.help}`);
      blocks.push(`# TYPE ${definition.name} ${definition.kind}`);

      for (const point of points.values()) {
        blocks.push(
          definition.kind === "histogram"
            ? renderHistogram(definition, point)
            : `${definition.name}${renderLabels(point.labels)} ${formatValue(point.value)}`,
        );
      }
    }

    // A trailing newline is required by the exposition format.
    return `${blocks.join("\n")}\n`;
  }

  private pointFor(metric: MetricDefinition, labels: MetricLabels): Point {
    let series = this.series.get(metric.name);
    if (series === undefined) {
      series = { definition: metric, points: new Map() };
      this.series.set(metric.name, series);
    }

    const key = labelKey(labels);
    let point = series.points.get(key);
    if (point === undefined) {
      point = { labels, value: 0 };
      series.points.set(key, point);
    }
    return point;
  }
}

function assertKind(metric: MetricDefinition, expected: MetricKind): void {
  if (metric.kind !== expected) {
    // A programmer error, not a runtime condition: the catalog says what this
    // metric is, and the call site disagrees.
    throw new TypeError(
      `Metric ${metric.name} is a ${metric.kind}; it cannot be used as a ${expected}.`,
    );
  }
}

/** Stable key for a label set, so `{a,b}` and `{b,a}` are the same series. */
function labelKey(labels: MetricLabels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([name, value]) => `${name}=${value}`).join(",");
}

function renderLabels(labels: MetricLabels, extra?: readonly [string, string]): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (extra !== undefined) entries.push([extra[0], extra[1]]);
  if (entries.length === 0) return "";

  const rendered = entries.map(([name, value]) => `${name}="${escapeLabelValue(value)}"`);
  return `{${rendered.join(",")}}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderHistogram(definition: MetricDefinition, point: Point): string {
  const buckets = definition.buckets ?? [];
  const counts = point.bucketCounts ?? [];
  const lines: string[] = [];

  for (const [index, bound] of buckets.entries()) {
    const labels = renderLabels(point.labels, ["le", formatValue(bound)]);
    lines.push(`${definition.name}_bucket${labels} ${String(counts[index] ?? 0)}`);
  }

  const infLabels = renderLabels(point.labels, ["le", "+Inf"]);
  lines.push(`${definition.name}_bucket${infLabels} ${String(counts[buckets.length] ?? 0)}`);
  lines.push(`${definition.name}_sum${renderLabels(point.labels)} ${formatValue(point.sum ?? 0)}`);
  lines.push(`${definition.name}_count${renderLabels(point.labels)} ${String(point.count ?? 0)}`);

  return lines.join("\n");
}

function formatValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  // Six significant digits: enough for millisecond sums, short enough to read.
  return value.toPrecision(6).replace(/\.?0+$/, "");
}
