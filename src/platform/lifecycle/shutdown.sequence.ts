import type { Logger } from "../logging/logger.contract.js";

interface ShutdownStep {
  readonly name: string;
  run(): Promise<void> | void;
}

/**
 * Ordered, bounded teardown.
 *
 * Steps run in reverse registration order, so teardown mirrors startup: the
 * last thing built is the first thing dismantled, and a step can rely on
 * everything registered before it still being alive. That ordering is what
 * makes "flush metrics to Redis" work — it is registered after Redis, so it
 * runs before Redis closes.
 *
 * The whole sequence is bounded. A step that hangs must not turn a deploy into
 * an outage, so the deadline is enforced and the process exits regardless.
 */
export class ShutdownSequence {
  private readonly steps: ShutdownStep[] = [];
  /**
   * The teardown in progress, so a second caller waits for it rather than
   * starting another or being told it failed.
   */
  private inFlight: Promise<boolean> | undefined;

  constructor(
    private readonly logger: Logger,
    private readonly timeoutMs: number,
  ) {}

  /** Registers a teardown step. Later registrations run earlier. */
  add(name: string, run: () => Promise<void> | void): void {
    this.steps.push({ name, run });
  }

  /**
   * Runs every step. Safe to call twice — a second SIGTERM while shutting down
   * is normal, and must not start a second teardown.
   *
   * @returns true if everything completed within the deadline.
   */
  async run(reason: string): Promise<boolean> {
    if (this.inFlight !== undefined) {
      // Joins the teardown already under way rather than reporting failure.
      //
      // The caller's next move on `false` is `process.exit(1)`, and the second
      // call is routine: a rejection thrown by an in-flight REST or pool
      // request *as it is being torn down* is exactly what a clean shutdown
      // provokes. Reporting failure there would exit the process mid-teardown,
      // killing the log transport's worker thread while it is flushing the
      // very lines explaining what happened — and turning a normal deploy into
      // a hard failure.
      this.logger.debug("Shutdown already in progress", { reason });
      return this.inFlight;
    }

    this.inFlight = this.execute(reason);
    return this.inFlight;
  }

  private async execute(reason: string): Promise<boolean> {
    this.logger.info("Shutting down", { reason, steps: this.steps.length });
    const startedAt = Date.now();

    const completed = await Promise.race([
      this.runSteps(),
      new Promise<false>((resolve) => {
        setTimeout(() => {
          resolve(false);
        }, this.timeoutMs).unref();
      }),
    ]);

    const durationMs = Date.now() - startedAt;
    if (completed) {
      this.logger.info("Shutdown complete", { durationMs });
    } else {
      this.logger.warn("Shutdown timed out; exiting anyway", {
        durationMs,
        timeoutMs: this.timeoutMs,
      });
    }

    return completed;
  }

  private async runSteps(): Promise<true> {
    for (const step of [...this.steps].reverse()) {
      const startedAt = Date.now();
      try {
        await step.run();
        this.logger.debug("Shutdown step finished", {
          step: step.name,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        // One failed step must not strand the rest — a Discord client that
        // refuses to close should not leave the database pool open.
        this.logger.error("Shutdown step failed", { error, step: step.name });
      }
    }
    return true;
  }
}
