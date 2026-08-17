/** Label values attached to one measurement. Keep cardinality low — never a user or guild id. */
export type MetricLabels = Readonly<Record<string, string>>;

export type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricDefinition {
  readonly name: string;
  readonly kind: MetricKind;
  readonly help: string;
  /** Upper bounds, ascending. Histograms only. */
  readonly buckets?: readonly number[];
}

/**
 * The metrics port.
 *
 * Metrics are declared up front in metrics.catalog.ts rather than created on
 * first use. Declaring them means a typo is a compile error instead of a second
 * metric nobody notices, and every series arrives with help text.
 *
 * Labels must be bounded: `command="ticket open"` is fine, `guild="…"` is not —
 * one series per guild is how a metrics backend falls over.
 */
export interface Metrics {
  increment(metric: MetricDefinition, labels?: MetricLabels, by?: number): void;
  observe(metric: MetricDefinition, value: number, labels?: MetricLabels): void;
  setGauge(metric: MetricDefinition, value: number, labels?: MetricLabels): void;
  /** Prometheus text exposition of everything recorded so far. */
  render(): string;
}
