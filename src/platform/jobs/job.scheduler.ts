import { createRequestContext, runWithRequestContext } from "../context/request-context.js";
import type { Lock } from "../locks/lock.contract.js";
import { detach, type Logger } from "../logging/logger.contract.js";
import { Metric } from "../metrics/metrics.catalog.js";
import type { Metrics } from "../metrics/metrics.contract.js";

import type { Job } from "./job.contract.js";

/**
 * Lease length relative to the interval. Long enough that a slow run keeps its
 * lease, short enough that a crashed instance's lock frees up promptly.
 */
const LEASE_MULTIPLIER = 3;

export interface JobRun {
  readonly jobId: string;
  readonly outcome: "ok" | "skipped" | "failed";
  readonly durationMs: number;
  readonly at: Date;
}

/**
 * Runs jobs on a fixed interval.
 *
 * Interval scheduling only — there is no cron expression support, because
 * nothing yet needs "3am on the first of the month" and a cron parser is a
 * dependency plus a timezone conversation. Add it when a job actually requires
 * wall-clock alignment (docs/architecture.md § Jobs).
 *
 * Every run is wrapped in a request context, so job logs carry a correlation id
 * and query counters exactly like an interaction does. Chasing a job's
 * behaviour through unlabelled logs is otherwise miserable.
 */
export class JobScheduler {
  private readonly jobs: Job[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly history: JobRun[] = [];
  private readonly logger: Logger;
  private running = false;
  /**
   * Job ids with a run under way.
   *
   * A job that takes longer than its interval must run *less often*, not
   * accumulate copies of itself. Without this, every tick started another run
   * and the overlap grew without bound — a singleton was covered by its lease
   * failing to be granted, but a non-singleton job had nothing stopping it at
   * all.
   */
  private readonly inProgress = new Set<string>();

  constructor(
    logger: Logger,
    private readonly metrics: Metrics,
    private readonly lock: Lock,
  ) {
    this.logger = logger.child({ subsystem: "jobs" });
  }

  register(job: Job): void {
    if (this.jobs.some((existing) => existing.id === job.id)) {
      // Two jobs under one id means one silently never runs. Fail at boot.
      throw new Error(`Duplicate job id: ${job.id}`);
    }
    this.jobs.push(job);
  }

  start(): void {
    if (this.running) return;
    this.running = true;

    for (const job of this.jobs) {
      const begin = (): void => {
        const timer = setInterval(() => {
          detach(this.execute(job), this.logger, "Job tick failed", { job: job.id });
        }, job.everyMs);
        timer.unref();
        this.timers.set(job.id, timer);
      };

      if (job.delayMs !== undefined && job.delayMs > 0) {
        const delay = setTimeout(begin, job.delayMs);
        delay.unref();
        this.timers.set(`${job.id}:delay`, delay);
      } else {
        begin();
      }
    }

    this.logger.info("Jobs started", { count: this.jobs.length });
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.running = false;
    // Deliberately not clearing `inProgress`: a run still in flight keeps its
    // guard across a stop, so a restart cannot start a second copy beside it.
    // The `finally` in `execute` is what releases an id, always.
  }

  /** The most recent runs, newest last. Surfaced by diagnostics. */
  recentRuns(): readonly JobRun[] {
    return this.history;
  }

  /**
   * Runs a job once, immediately. Exposed for tests and manual triggering.
   *
   * A call made while the same job is already running is skipped rather than
   * queued: running it twice over is not what "it is due again" means, and
   * queueing would turn a slow job into a backlog that never drains.
   */
  async execute(job: Job): Promise<JobRun> {
    const startedAt = Date.now();

    if (this.inProgress.has(job.id)) {
      this.logger.debug("Skipped a job tick — the previous run is still going", { job: job.id });
      return this.record(job, "skipped", startedAt);
    }
    this.inProgress.add(job.id);

    const context = createRequestContext({ source: "job", operation: job.id }, startedAt);

    return runWithRequestContext(context, async () => {
      // Set from inside the critical section rather than inferred from what
      // runExclusive returned. `Job.run` resolves to void, so the lock's "was
      // it held?" signal — an undefined result — is indistinguishable from a
      // job that ran perfectly well and returned nothing. Reading the return
      // value would mark every singleton job "skipped", forever.
      let ran = false;

      try {
        if (job.singleton) {
          await this.lock.runExclusive(
            `job:${job.id}`,
            job.everyMs * LEASE_MULTIPLIER,
            async (signal) => {
              ran = true;
              await job.run(signal);
            },
          );
        } else {
          ran = true;
          await job.run(new AbortController().signal);
        }

        // A singleton skipped because another instance holds the lease is a
        // normal outcome, not a failure — it means the system is working.
        return this.record(job, ran ? "ok" : "skipped", startedAt);
      } catch (error) {
        this.logger.error("Job failed", { error, job: job.id });
        return this.record(job, "failed", startedAt);
      } finally {
        // Cleared even on failure, so one bad run does not stop the job for
        // the life of the process.
        this.inProgress.delete(job.id);
      }
    });
  }

  private record(job: Job, outcome: JobRun["outcome"], startedAt: number): JobRun {
    const durationMs = Date.now() - startedAt;

    this.metrics.increment(Metric.jobRunTotal, { job: job.id, outcome });
    this.metrics.observe(Metric.jobDurationMs, durationMs, { job: job.id });

    if (outcome === "ok") {
      this.logger.debug("Job finished", { job: job.id, durationMs });
    }

    const run: JobRun = { jobId: job.id, outcome, durationMs, at: new Date(startedAt) };
    this.history.push(run);
    // Bounded: history is a diagnostic aid, not a log store.
    if (this.history.length > 100) this.history.shift();
    return run;
  }
}
