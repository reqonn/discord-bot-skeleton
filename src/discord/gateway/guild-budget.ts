/**
 * A rolling count of outbound actions per guild.
 *
 * Per-guild rather than global because the failure this prevents is one busy
 * server consuming the bot's entire rate-limit allowance and degrading every
 * other server it is in. Isolating the blast radius is the whole point; a
 * global counter would spread it instead.
 *
 * Timestamps are kept sorted (they arrive in order), so expiring the window is
 * a binary search plus one splice rather than a scan.
 */
export class GuildBudget {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly maxActions: number,
    private readonly now: () => number = Date.now,
  ) {}

  record(guildId: string): void {
    const timestamps = this.windows.get(guildId) ?? [];
    timestamps.push(this.now());
    this.windows.set(guildId, timestamps);
  }

  /** Actions inside the current window. */
  usage(guildId: string): number {
    const timestamps = this.windows.get(guildId);
    if (timestamps === undefined) return 0;

    this.trim(timestamps);
    if (timestamps.length === 0) this.windows.delete(guildId);
    return timestamps.length;
  }

  /** 0 when idle, 1 at the limit, above 1 when over it. */
  pressure(guildId: string): number {
    return this.usage(guildId) / this.maxActions;
  }

  hasCapacity(guildId: string): boolean {
    return this.usage(guildId) < this.maxActions;
  }

  /** Drops guilds that have gone quiet, so an idle server costs no memory. */
  sweep(): void {
    for (const [guildId, timestamps] of this.windows) {
      this.trim(timestamps);
      if (timestamps.length === 0) this.windows.delete(guildId);
    }
  }

  get trackedGuilds(): number {
    return this.windows.size;
  }

  clear(): void {
    this.windows.clear();
  }

  /** Removes timestamps older than the window, in place. */
  private trim(timestamps: number[]): void {
    const cutoff = this.now() - this.windowMs;
    if (timestamps.length === 0 || (timestamps[0] ?? 0) > cutoff) return;

    // Binary search for the first entry still inside the window. Under a burst
    // this list can hold hundreds of entries and is trimmed on every check.
    let low = 0;
    let high = timestamps.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if ((timestamps[mid] ?? 0) > cutoff) high = mid;
      else low = mid + 1;
    }

    timestamps.splice(0, low);
  }
}
