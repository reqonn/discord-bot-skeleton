import type { Lock } from "./lock.contract.js";

/**
 * A process-local mutex.
 *
 * Correct for exactly one instance, which is what development is. It never
 * loses its lease, so the abort signal it passes never fires — meaning code
 * written against it can still be wrong under the Redis implementation. That is
 * a real hazard, and the reason production configuration refuses to start
 * without Redis rather than quietly falling back to this.
 */
export class LocalLock implements Lock {
  private readonly held = new Set<string>();

  async runExclusive<T>(
    name: string,
    _ttlMs: number,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | undefined> {
    if (this.held.has(name)) return undefined;
    this.held.add(name);

    const controller = new AbortController();
    try {
      return await work(controller.signal);
    } finally {
      this.held.delete(name);
    }
  }
}
