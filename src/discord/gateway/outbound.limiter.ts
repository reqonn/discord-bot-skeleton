import type { Logger } from "../../platform/logging/logger.contract.js";
import { Metric } from "../../platform/metrics/metrics.catalog.js";
import type { Metrics } from "../../platform/metrics/metrics.contract.js";
import { DiscordError, type AppError } from "../../shared/errors/app-error.js";
import { err, ok, type Result } from "../../shared/result/result.js";
import { toAppError } from "../kernel/error-mapper.js";

import {
  ActionPriority,
  DEFAULT_LIMITER_SETTINGS,
  type ActionOutcome,
  type LimiterSettings,
} from "./action.types.js";
import { CircuitBreaker, circuitKey } from "./circuit-breaker.js";
import { GuildBudget } from "./guild-budget.js";

/** Actions outside any guild — direct messages, application-level calls. */
const GLOBAL_LANE = "global";

/** The single key the process-wide budget counts against. */
const EVERYTHING = "*";

export interface ActionRequest<T> {
  /** Null outside a guild. */
  readonly guildId: string | null;
  /** Groups the circuit breaker and metrics, e.g. "tickets". */
  readonly feature: string;
  readonly priority: ActionPriority;
  execute(): Promise<T>;
}

interface PendingAction {
  readonly priority: ActionPriority;
  readonly feature: string;
  readonly expiresAt: number;
  start(): void;
  abandon(outcome: "dropped" | "timed-out"): void;
}

interface Lane {
  inFlight: number;
  /** One queue per priority, indexed by its numeric value. */
  readonly queues: PendingAction[][];
}

export interface LimiterStats {
  readonly queueDepth: number;
  readonly inFlight: number;
  readonly openCircuits: number;
  readonly trackedGuilds: number;
  /** Actions sent process-wide inside the global window. */
  readonly globalUsage: number;
}

/**
 * Governs every outbound Discord API call.
 *
 * Interaction replies deliberately do **not** pass through here: they use the
 * interaction token, which Discord rate-limits separately from channel and
 * guild routes. Budgeting them against a per-guild allowance would be modelling
 * the wrong thing, and adding a queue to the latency-critical path would risk
 * the 3-second acknowledgement window for no benefit.
 *
 * What it protects against is the failure mode that takes a bot down globally:
 * one guild — usually mid-raid — generating enough outbound calls to exhaust
 * the rate-limit allowance, at which point Discord's 429s apply to every guild
 * the bot is in. Per-guild budgets keep that contained.
 *
 * Returns `Result` rather than null. A dropped action is a real outcome the
 * caller must decide about, and a nullable return is too easy to treat as
 * success.
 *
 * Call `start()` before use. Queued work is normally released when an in-flight
 * call completes, but when a *budget* is what holds it back nothing completes to
 * trigger that — the drain tick is what releases it, and it is also what expires
 * work that has waited too long.
 */
export class OutboundLimiter {
  private readonly settings: LimiterSettings;
  private readonly budget: GuildBudget;
  /** The process-wide ceiling, counted across every guild at once. */
  private readonly global: GuildBudget;
  private readonly breaker: CircuitBreaker;
  private readonly lanes = new Map<string, Lane>();
  /** Where the next drain sweep starts, so no guild is permanently last. */
  private drainCursor = 0;
  private readonly logger: Logger;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    logger: Logger,
    private readonly metrics: Metrics,
    settings: Partial<LimiterSettings> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.settings = { ...DEFAULT_LIMITER_SETTINGS, ...settings };
    this.logger = logger.child({ subsystem: "discord-limiter" });
    this.budget = new GuildBudget(
      this.settings.budgetWindowMs,
      this.settings.budgetMaxActions,
      now,
    );
    this.global = new GuildBudget(
      this.settings.globalWindowMs,
      this.settings.globalMaxActions,
      now,
    );
    this.breaker = new CircuitBreaker(
      {
        failureThreshold: this.settings.circuitFailureThreshold,
        windowMs: this.settings.circuitWindowMs,
        cooldownMs: this.settings.circuitCooldownMs,
      },
      now,
    );
  }

  start(): void {
    if (this.timers.length > 0) return;

    // A safety net. Queued actions are normally released when an in-flight call
    // completes, but when the *budget* is what is holding them back nothing
    // completes to trigger that — so something has to tick.
    const drain = setInterval(() => {
      this.drainAll();
      // Published on the drain tick rather than the sweep: a queue-depth gauge
      // that is up to a minute stale is worse than no gauge, because it reads
      // as current.
      this.publish();
    }, this.settings.drainIntervalMs);

    const sweep = setInterval(() => {
      this.budget.sweep();
      this.global.sweep();
      this.breaker.sweep();
    }, this.settings.sweepIntervalMs);

    for (const timer of [drain, sweep]) timer.unref();
    this.timers = [drain, sweep];
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const [, lane] of this.lanes) {
      for (const queue of lane.queues) {
        for (const pending of queue.splice(0)) pending.abandon("dropped");
      }
    }
    this.lanes.clear();
    this.budget.clear();
    this.global.clear();
    this.breaker.clear();
  }

  async run<T>(request: ActionRequest<T>): Promise<Result<T, AppError>> {
    const laneKey = request.guildId ?? GLOBAL_LANE;
    const key = circuitKey(laneKey, request.feature);
    const critical = request.priority === ActionPriority.Critical;

    if (!critical && !this.breaker.allows(key)) {
      this.record(request.feature, "short-circuited");
      return err(
        new DiscordError(`Circuit open for ${key}; refusing to call Discord until it recovers.`),
      );
    }

    const lane = this.laneFor(laneKey);
    const hasRoom =
      lane.inFlight < this.settings.concurrencyPerGuild &&
      this.budget.hasCapacity(laneKey) &&
      this.global.hasCapacity(EVERYTHING);

    // Critical work bypasses the queue entirely. It is still measured, so it
    // still trips the breaker and still consumes budget — it just never waits.
    if (critical || hasRoom) return this.execute(request, laneKey, key, "executed");

    return this.enqueue(request, laneKey, key, lane);
  }

  stats(): LimiterStats {
    let queueDepth = 0;
    let inFlight = 0;
    for (const [, lane] of this.lanes) {
      inFlight += lane.inFlight;
      for (const queue of lane.queues) queueDepth += queue.length;
    }

    return {
      queueDepth,
      inFlight,
      openCircuits: this.breaker.openCount(),
      trackedGuilds: this.budget.trackedGuilds,
      globalUsage: this.global.usage(EVERYTHING),
    };
  }

  /**
   * Drains every lane, round-robin.
   *
   * Insertion order would mean the same guild is served first on every tick,
   * and under a saturated global ceiling the guilds at the back would never be
   * reached. Rotating the starting point costs nothing and makes starvation
   * impossible rather than merely unlikely.
   *
   * Exposed so tests can advance the queue without waiting on a timer.
   */
  drainAll(): void {
    const keys = [...this.lanes.keys()];
    if (keys.length === 0) return;

    const start = this.drainCursor % keys.length;
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[(start + i) % keys.length];
      if (key !== undefined) this.drain(key);
    }

    this.drainCursor = (start + 1) % keys.length;
  }

  private async execute<T>(
    request: ActionRequest<T>,
    laneKey: string,
    key: string,
    outcome: "executed" | "queued",
  ): Promise<Result<T, AppError>> {
    const lane = this.laneFor(laneKey);
    lane.inFlight += 1;
    this.budget.record(laneKey);
    // Critical work skips the queue but is still counted, so the ceiling
    // reflects everything actually sent rather than only what waited.
    this.global.record(EVERYTHING);

    try {
      const value = await request.execute();
      this.breaker.recordSuccess(key);
      this.record(request.feature, outcome);
      return ok(value);
    } catch (error) {
      this.breaker.recordFailure(key);
      this.record(request.feature, "failed");
      this.logger.warn("Outbound Discord call failed", { error, feature: request.feature });
      return err(toAppError(error));
    } finally {
      lane.inFlight -= 1;
      this.drain(laneKey);
    }
  }

  private enqueue<T>(
    request: ActionRequest<T>,
    laneKey: string,
    key: string,
    lane: Lane,
  ): Promise<Result<T, AppError>> {
    if (this.depthOf(lane) >= this.settings.queueMaxPerGuild && !this.evictLower(lane, request)) {
      this.record(request.feature, "dropped");
      return Promise.resolve(
        err(new DiscordError(`Outbound queue full for ${laneKey}; dropped ${request.feature}.`)),
      );
    }

    return new Promise<Result<T, AppError>>((resolve) => {
      const queue = lane.queues[request.priority];
      queue?.push({
        priority: request.priority,
        feature: request.feature,
        expiresAt: this.now() + this.settings.queueTimeoutMs,
        start: () => {
          void this.execute(request, laneKey, key, "queued").then(resolve);
        },
        abandon: (outcome) => {
          this.record(request.feature, outcome);
          resolve(err(new DiscordError(`Outbound action ${outcome}: ${request.feature}.`)));
        },
      });
    });
  }

  /**
   * Makes room for a more urgent action by dropping the least urgent waiter.
   * Returns false when nothing queued is lower priority — in which case the
   * incoming action is the one that gets dropped, which is the correct
   * outcome.
   */
  private evictLower(lane: Lane, request: ActionRequest<unknown>): boolean {
    for (let priority = ActionPriority.Low; priority > request.priority; priority -= 1) {
      const victim = lane.queues[priority]?.shift();
      if (victim !== undefined) {
        victim.abandon("dropped");
        return true;
      }
    }
    return false;
  }

  private drain(laneKey: string): void {
    const lane = this.lanes.get(laneKey);
    if (lane === undefined) return;

    const at = this.now();
    for (const queue of lane.queues) {
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const pending = queue[i];
        if (pending !== undefined && pending.expiresAt <= at) {
          queue.splice(i, 1);
          pending.abandon("timed-out");
        }
      }
    }

    while (
      lane.inFlight < this.settings.concurrencyPerGuild &&
      this.budget.hasCapacity(laneKey) &&
      this.global.hasCapacity(EVERYTHING)
    ) {
      const next = this.takeNext(lane);
      if (next === undefined) break;
      next.start();
    }

    if (lane.inFlight === 0 && this.depthOf(lane) === 0) this.lanes.delete(laneKey);
  }

  /** Highest priority first, oldest first within a priority. */
  private takeNext(lane: Lane): PendingAction | undefined {
    for (const queue of lane.queues) {
      const next = queue.shift();
      if (next !== undefined) return next;
    }
    return undefined;
  }

  private depthOf(lane: Lane): number {
    return lane.queues.reduce((total, queue) => total + queue.length, 0);
  }

  private laneFor(laneKey: string): Lane {
    let lane = this.lanes.get(laneKey);
    if (lane === undefined) {
      lane = { inFlight: 0, queues: [[], [], [], []] };
      this.lanes.set(laneKey, lane);
    }
    return lane;
  }

  private record(feature: string, outcome: ActionOutcome): void {
    this.metrics.increment(Metric.discordActionTotal, { feature, outcome });
  }

  private publish(): void {
    const stats = this.stats();
    this.metrics.setGauge(Metric.discordActionQueueDepth, stats.queueDepth);
    this.metrics.setGauge(Metric.discordCircuitsOpen, stats.openCircuits);
  }
}
