import { describe, expect, it } from "vitest";

import {
  createCorrelationId,
  createRequestContext,
  getRequestContext,
  recordCacheHit,
  recordCacheMiss,
  recordQuery,
  runWithRequestContext,
} from "#platform/context/request-context.js";

import { asSnowflake } from "#shared/types/snowflake.types.js";

function context() {
  return createRequestContext(
    { source: "command", operation: "ping", guildId: asSnowflake("111111111111111111") },
    1_000,
  );
}

describe("request context", () => {
  it("has no ambient context by default", () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it("exposes the context to synchronous callees", () => {
    const ctx = context();

    runWithRequestContext(ctx, () => {
      expect(getRequestContext()).toBe(ctx);
    });
  });

  it("survives await boundaries", async () => {
    const ctx = context();

    await runWithRequestContext(ctx, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      // This is the property the whole design rests on: a use case five awaits
      // deep still sees the correlation id without being handed it.
      expect(getRequestContext()?.correlationId).toBe(ctx.correlationId);
    });
  });

  it("does not leak between concurrent requests", async () => {
    const first = context();
    const second = context();

    const observed = await Promise.all([
      runWithRequestContext(first, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return getRequestContext()?.correlationId;
      }),
      // Resolves while the first is still suspended, which is precisely the
      // interleaving that would expose a shared store.
      runWithRequestContext(second, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getRequestContext()?.correlationId;
      }),
    ]);

    expect(observed).toEqual([first.correlationId, second.correlationId]);
    expect(first.correlationId).not.toBe(second.correlationId);
  });

  it("clears the context once the request ends", () => {
    runWithRequestContext(context(), () => {
      /* inside */
    });

    expect(getRequestContext()).toBeUndefined();
  });

  it("generates distinct correlation ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => createCorrelationId()));

    expect(ids.size).toBe(500);
  });

  describe("counters", () => {
    it("accumulates query count and duration", () => {
      const ctx = context();

      runWithRequestContext(ctx, () => {
        recordQuery(4);
        recordQuery(6);
      });

      expect(ctx.counters.queries).toBe(2);
      expect(ctx.counters.queryDurationMs).toBe(10);
    });

    it("accumulates cache outcomes", () => {
      const ctx = context();

      runWithRequestContext(ctx, () => {
        recordCacheHit();
        recordCacheHit();
        recordCacheMiss();
      });

      expect(ctx.counters.cacheHits).toBe(2);
      expect(ctx.counters.cacheMisses).toBe(1);
    });

    it("is a no-op outside a request, so infrastructure never has to check", () => {
      expect(() => {
        recordQuery(1);
        recordCacheHit();
        recordCacheMiss();
      }).not.toThrow();
    });
  });
});
