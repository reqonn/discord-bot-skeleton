import type { Cache, CacheNamespace } from "./cache.contract.js";
import type { MemoryCache } from "./memory.cache.js";

/**
 * In-process L1 in front of a shared L2.
 *
 * L1 turns a hot key into a map lookup — microseconds instead of a network
 * round trip — which is what keeps a warm command's database and cache cost at
 * zero. L2 is what makes the cache shared, survive a restart, and stay useful
 * with more than one instance.
 *
 * Known limitation: an invalidation clears this process's L1 and the shared L2,
 * but another instance keeps its own L1 until the entry expires. That is
 * acceptable while namespace TTLs are short and stale reads are tolerable;
 * anything where it is not — a permission revoke, say — needs pub/sub
 * invalidation, which is deliberately not built until something needs it.
 * See docs/architecture.md § Caching.
 */
export class TieredCache implements Cache {
  constructor(
    private readonly l1: MemoryCache,
    private readonly l2: Cache,
  ) {}

  async get<T>(namespace: CacheNamespace, id: string): Promise<T | undefined> {
    // Marked before either tier is asked, for the reason `MemoryCache.getOrLoad`
    // marks before its load: the shared tier is a round trip, and an
    // invalidation can land while it is answering.
    const mark = this.l1.markLoad(namespace, id);

    const local = await this.l1.get<T>(namespace, id);
    if (local !== undefined) return local;

    const shared = await this.l2.get<T>(namespace, id);

    // Promoted so the next read on this instance costs nothing — unless
    // something invalidated the key meanwhile, in which case promoting would
    // put back into L1 exactly what the invalidation took out of it, and leave
    // it there for the full TTL. This is the one place that wrote to a tier
    // without the guard `getOrLoad` already applies to its own write.
    if (shared !== undefined && this.l1.isCurrent(namespace, id, mark)) {
      await this.l1.set(namespace, id, shared);
    }

    // Returned to the caller either way. They asked before the change, and it
    // is only the *caching* of the answer that is refused.
    return shared;
  }

  async set<T>(namespace: CacheNamespace, id: string, value: T): Promise<void> {
    await Promise.all([this.l1.set(namespace, id, value), this.l2.set(namespace, id, value)]);
  }

  async delete(namespace: CacheNamespace, id: string): Promise<void> {
    await Promise.all([this.l1.delete(namespace, id), this.l2.delete(namespace, id)]);
  }

  async clear(namespace: CacheNamespace): Promise<void> {
    await Promise.all([this.l1.clear(namespace), this.l2.clear(namespace)]);
  }

  async getOrLoad<T>(namespace: CacheNamespace, id: string, load: () => Promise<T>): Promise<T> {
    // Delegating to L1's getOrLoad gives per-process single-flighting for free,
    // and the loader it runs consults L2 before touching the origin.
    return this.l1.getOrLoad(namespace, id, () => this.l2.getOrLoad(namespace, id, load));
  }
}
