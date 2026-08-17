export type CircuitState = "closed" | "open" | "half-open";

interface Circuit {
  failures: number;
  /** Start of the current failure window. */
  windowStartedAt: number;
  openedAt: number | undefined;
  /** A probe is in flight; no other call may pass while half-open. */
  probing: boolean;
  lastTouchedAt: number;
}

export interface CircuitSettings {
  readonly failureThreshold: number;
  readonly windowMs: number;
  readonly cooldownMs: number;
}

/**
 * Stops hammering something that is already failing.
 *
 * Keyed per guild *and* feature, because the two failure modes it catches are
 * different and both matter: a guild where the bot has lost permissions (every
 * feature fails there, nowhere else) and a feature calling a broken endpoint
 * (fails everywhere, one feature). A single global breaker would confuse them
 * and trip on neither in time.
 *
 * After the cooldown the circuit admits exactly one probe. If that succeeds the
 * circuit closes; if it fails the cooldown restarts. Admitting everything at
 * once instead would re-flood the failing dependency the moment it began to
 * recover.
 */
export class CircuitBreaker {
  private readonly circuits = new Map<string, Circuit>();

  constructor(
    private readonly settings: CircuitSettings,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a call may proceed. Transitions open → half-open when due. */
  allows(key: string): boolean {
    const circuit = this.circuits.get(key);
    if (circuit === undefined || circuit.openedAt === undefined) return true;

    const cooledDown = this.now() - circuit.openedAt >= this.settings.cooldownMs;
    if (!cooledDown) return false;

    // Cooled down: admit one probe and hold everything else back until it
    // reports.
    if (circuit.probing) return false;
    circuit.probing = true;
    return true;
  }

  state(key: string): CircuitState {
    const circuit = this.circuits.get(key);
    if (circuit === undefined || circuit.openedAt === undefined) return "closed";

    return this.now() - circuit.openedAt >= this.settings.cooldownMs ? "half-open" : "open";
  }

  recordSuccess(key: string): void {
    // A success is proof the dependency works, so the failure count resets
    // rather than decays — a slow trickle of failures should not accumulate
    // into an open circuit across an otherwise healthy hour.
    this.circuits.delete(key);
  }

  recordFailure(key: string): void {
    const at = this.now();
    const circuit = this.circuits.get(key) ?? {
      failures: 0,
      windowStartedAt: at,
      openedAt: undefined,
      probing: false,
      lastTouchedAt: at,
    };

    circuit.lastTouchedAt = at;
    circuit.probing = false;

    if (circuit.openedAt !== undefined) {
      // A failed probe. Restart the cooldown rather than closing.
      circuit.openedAt = at;
      this.circuits.set(key, circuit);
      return;
    }

    if (at - circuit.windowStartedAt > this.settings.windowMs) {
      circuit.failures = 0;
      circuit.windowStartedAt = at;
    }

    circuit.failures += 1;
    if (circuit.failures >= this.settings.failureThreshold) {
      circuit.openedAt = at;
    }

    this.circuits.set(key, circuit);
  }

  /** Open circuits, for the metrics gauge. */
  openCount(): number {
    let open = 0;
    for (const [key] of this.circuits) {
      if (this.state(key) !== "closed") open += 1;
    }
    return open;
  }

  /** Forgets circuits nothing has touched for a while. */
  sweep(): void {
    const stale = this.now() - Math.max(this.settings.cooldownMs, this.settings.windowMs) * 2;
    for (const [key, circuit] of this.circuits) {
      if (circuit.lastTouchedAt < stale) this.circuits.delete(key);
    }
  }

  clear(): void {
    this.circuits.clear();
  }
}

/** Circuits are keyed by guild and feature together. */
export function circuitKey(guildId: string, feature: string): string {
  return `${guildId}:${feature}`;
}
