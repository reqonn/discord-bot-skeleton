import type { CooldownStore, CooldownVerdict } from "./cooldown.contract.js";

interface Window {
  count: number;
  /** When this window closes and the count resets. */
  expiresAt: number;
}

const SWEEP_INTERVAL_MS = 60_000;

/**
 * In-process fixed-window cooldowns.
 *
 * A fixed window, not a sliding one: it costs one integer per key instead of a
 * timestamp list, and its only weakness — up to 2× the limit across a window
 * boundary — does not matter for what this guards. Command cooldowns exist to
 * stop a user spamming a button, not to meter a paid API.
 *
 * Process-local, so cooldowns reset on restart and are not shared between
 * instances. Acceptable in development; a Redis-backed implementation behind
 * the same port is what production wires.
 */
export class MemoryCooldownStore implements CooldownStore {
  private readonly windows = new Map<string, Window>();
  private sweeper: NodeJS.Timeout | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  start(): void {
    if (this.sweeper !== undefined) return;
    this.sweeper = setInterval(() => {
      this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  stop(): void {
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    this.sweeper = undefined;
    this.windows.clear();
  }

  hit(key: string, limit: number, windowMs: number): Promise<CooldownVerdict> {
    const now = this.now();
    const existing = this.windows.get(key);

    if (existing === undefined || existing.expiresAt <= now) {
      this.windows.set(key, { count: 1, expiresAt: now + windowMs });
      return Promise.resolve({ allowed: true, retryAfterMs: 0 });
    }

    existing.count += 1;

    return Promise.resolve(
      existing.count <= limit
        ? { allowed: true, retryAfterMs: 0 }
        : { allowed: false, retryAfterMs: existing.expiresAt - now },
    );
  }

  private sweep(): void {
    const now = this.now();
    for (const [key, window] of this.windows) {
      if (window.expiresAt <= now) this.windows.delete(key);
    }
  }
}
