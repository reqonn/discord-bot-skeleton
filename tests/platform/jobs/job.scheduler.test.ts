import { describe, expect, it } from "vitest";

import type { Job } from "#platform/jobs/job.contract.js";
import { JobScheduler } from "#platform/jobs/job.scheduler.js";
import { LocalLock } from "#platform/locks/local.lock.js";
import type { Lock } from "#platform/locks/lock.contract.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import { MemoryLogger } from "#testing/memory.logger.js";

/**
 * The job scheduler, run for real.
 *
 * This suite exists because the scheduler shipped with no test and no caller —
 * 135 lines of scheduling, locking and metrics that had never executed. The
 * first thing it found was a genuine bug: outcome was inferred from what
 * `runExclusive` returned, but `Job.run` resolves to void, so a job that ran
 * perfectly was indistinguishable from one skipped because another instance
 * held the lease. Every singleton job would have been recorded "skipped"
 * forever, and singleton is the recommended setting for anything with effects.
 */

function scheduler(lock: Lock = new LocalLock()): {
  jobs: JobScheduler;
  metrics: MetricsRegistry;
  logger: MemoryLogger;
} {
  const metrics = new MetricsRegistry();
  const logger = new MemoryLogger();
  return { jobs: new JobScheduler(logger, metrics, lock), metrics, logger };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "test.job",
    everyMs: 60_000,
    singleton: false,
    run: () => Promise.resolve(),
    ...overrides,
  };
}

/** A lock that never grants — models another instance already holding it. */
const heldElsewhere: Lock = { runExclusive: () => Promise.resolve(undefined) };

describe("JobScheduler", () => {
  describe("registration", () => {
    it("rejects a duplicate id, rather than silently running one of them", () => {
      const { jobs } = scheduler();
      jobs.register(job({ id: "tickets.expire" }));

      // Two jobs under one id means one never runs, with nothing to show for it.
      expect(() => {
        jobs.register(job({ id: "tickets.expire" }));
      }).toThrow("Duplicate job id: tickets.expire");
    });

    it("accepts distinct ids", () => {
      const { jobs } = scheduler();
      jobs.register(job({ id: "a" }));

      expect(() => {
        jobs.register(job({ id: "b" }));
      }).not.toThrow();
    });
  });

  describe("running a job", () => {
    it("runs it and records the outcome", async () => {
      const { jobs } = scheduler();
      let ran = false;

      const run = await jobs.execute(
        job({
          run: () => {
            ran = true;
            return Promise.resolve();
          },
        }),
      );

      expect(ran).toBe(true);
      expect(run).toMatchObject({ jobId: "test.job", outcome: "ok" });
    });

    it("reports a singleton that ran as ok, not skipped", async () => {
      // The regression. `Job.run` resolves to void, so the lock returning
      // undefined says nothing about whether the work happened.
      const { jobs } = scheduler();
      let ran = false;

      const run = await jobs.execute(
        job({
          singleton: true,
          run: () => {
            ran = true;
            return Promise.resolve();
          },
        }),
      );

      expect(ran).toBe(true);
      expect(run.outcome).toBe("ok");
    });

    it("reports skipped when another instance holds the lease", async () => {
      const { jobs } = scheduler(heldElsewhere);
      let ran = false;

      const run = await jobs.execute(
        job({
          singleton: true,
          run: () => {
            ran = true;
            return Promise.resolve();
          },
        }),
      );

      // Skipped is a healthy outcome: it means the lock is doing its job.
      expect(ran).toBe(false);
      expect(run.outcome).toBe("skipped");
    });

    it("takes no lock for a job that is not a singleton", async () => {
      // Non-singleton work must run on every instance, so a held lock elsewhere
      // must not stop it.
      const { jobs } = scheduler(heldElsewhere);

      const run = await jobs.execute(job({ singleton: false }));

      expect(run.outcome).toBe("ok");
    });

    it("records a failure instead of throwing", async () => {
      const { jobs, logger } = scheduler();

      const run = await jobs.execute(job({ run: () => Promise.reject(new Error("boom")) }));

      // A throwing job must not take down the interval that scheduled it.
      expect(run.outcome).toBe("failed");
      expect(logger.messages("error")).toContain("Job failed");
    });

    it("passes a signal the job can check", async () => {
      const { jobs } = scheduler();
      let received: AbortSignal | undefined;

      await jobs.execute(
        job({
          singleton: true,
          run: (signal) => {
            received = signal;
            return Promise.resolve();
          },
        }),
      );

      expect(received).toBeInstanceOf(AbortSignal);
    });
  });

  describe("metrics and history", () => {
    it("counts every run by outcome", async () => {
      const { jobs, metrics } = scheduler();
      await jobs.execute(job({ id: "a" }));
      await jobs.execute(job({ id: "a", run: () => Promise.reject(new Error("x")) }));

      const exposed = metrics.render();

      expect(exposed).toContain('outcome="ok"');
      expect(exposed).toContain('outcome="failed"');
    });

    it("keeps recent runs, newest last", async () => {
      const { jobs } = scheduler();
      await jobs.execute(job({ id: "first" }));
      await jobs.execute(job({ id: "second" }));

      expect(jobs.recentRuns().map((run) => run.jobId)).toEqual(["first", "second"]);
    });

    it("bounds the history, because it is a diagnostic not a log store", async () => {
      const { jobs } = scheduler();
      for (let index = 0; index < 105; index += 1) await jobs.execute(job());

      expect(jobs.recentRuns().length).toBeLessThanOrEqual(100);
    });
  });

  describe("start and stop", () => {
    it("starts without jobs, which is the state this skeleton ships in", () => {
      const { jobs, logger } = scheduler();

      expect(() => {
        jobs.start();
      }).not.toThrow();
      expect(logger.messages()).toContain("Jobs started");

      jobs.stop();
    });

    it("is idempotent, so a double start does not schedule twice", () => {
      const { jobs, logger } = scheduler();
      jobs.register(job());

      jobs.start();
      jobs.start();

      expect(logger.messages().filter((message) => message === "Jobs started")).toHaveLength(1);
      jobs.stop();
    });

    it("can be started again after stopping", () => {
      const { jobs } = scheduler();
      jobs.register(job());

      jobs.start();
      jobs.stop();

      expect(() => {
        jobs.start();
      }).not.toThrow();
      jobs.stop();
    });
  });
});
