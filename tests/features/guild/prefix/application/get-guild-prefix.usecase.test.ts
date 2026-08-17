import { beforeEach, describe, expect, it } from "vitest";

import { MemoryCache } from "#platform/cache/memory.cache.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import { GetGuildPrefixUseCase } from "#features/guild/prefix/application/get-guild-prefix.usecase.js";

import { asSnowflake } from "#shared/types/snowflake.types.js";

import { MemoryGuildPrefixRepository } from "#testing/memory.guild-prefix.repository.js";

/**
 * The read path, including its cache.
 *
 * No database runs in this file. The use case depends on a port, so the test
 * supplies an in-memory one — which is also what makes the caching assertions
 * possible: the fake counts reads, so "the cache worked" is provable rather
 * than assumed.
 */

const GUILD = asSnowflake("100000000000000001");
const OTHER = asSnowflake("200000000000000002");

let cache: MemoryCache;

function build(seed: Readonly<Record<string, string>> = {}) {
  const repository = new MemoryGuildPrefixRepository(seed);
  cache = new MemoryCache(new MetricsRegistry());
  return { repository, useCase: new GetGuildPrefixUseCase(repository, cache) };
}

beforeEach(() => {
  cache?.stop();
});

describe("GetGuildPrefixUseCase", () => {
  it("returns a guild's stored prefix", async () => {
    const { useCase } = build({ [GUILD]: "?" });

    const result = await useCase.execute(GUILD);

    expect(result.ok && result.value).toBe("?");
  });

  it("returns null when the guild has set none", async () => {
    // Null, not undefined: the answer "there is no override" has to be
    // storable in the cache, or the common case never caches.
    const { useCase } = build();

    const result = await useCase.execute(GUILD);

    expect(result.ok && result.value).toBeNull();
  });

  describe("caching", () => {
    it("reads storage once, then serves from cache", async () => {
      const { repository, useCase } = build({ [GUILD]: "?" });

      await useCase.execute(GUILD);
      await useCase.execute(GUILD);
      await useCase.execute(GUILD);

      // This is the hot path: every message in every guild. One read per
      // minute rather than one per message is the whole point.
      expect(repository.reads).toBe(1);
    });

    it("caches the absence of an override too", async () => {
      // Most guilds never set one, so this is the common case. Without it,
      // the majority of traffic would hit the database on every message.
      const { repository, useCase } = build();

      await useCase.execute(GUILD);
      await useCase.execute(GUILD);

      expect(repository.reads).toBe(1);
    });

    it("single-flights a burst of concurrent misses", async () => {
      // A busy guild whose entry has just expired must produce one database
      // read, not one per message in flight.
      const { repository, useCase } = build({ [GUILD]: "?" });

      await Promise.all([useCase.execute(GUILD), useCase.execute(GUILD), useCase.execute(GUILD)]);

      expect(repository.reads).toBe(1);
    });

    it("keeps guilds apart", async () => {
      const { useCase } = build({ [GUILD]: "?", [OTHER]: ">" });

      await expect(useCase.execute(GUILD)).resolves.toMatchObject({ value: "?" });
      await expect(useCase.execute(OTHER)).resolves.toMatchObject({ value: ">" });
    });

    it("reads storage again after the entry is invalidated", async () => {
      const { repository, useCase } = build({ [GUILD]: "?" });
      await useCase.execute(GUILD);

      await useCase.invalidate(GUILD);
      await useCase.execute(GUILD);

      expect(repository.reads).toBe(2);
    });

    it("sees a write that happened behind it, once invalidated", async () => {
      // The write path's contract: save, then invalidate. This proves the
      // second half actually matters.
      const { repository, useCase } = build({ [GUILD]: "?" });
      await useCase.execute(GUILD);

      await repository.save(GUILD, ">>");
      await useCase.invalidate(GUILD);

      await expect(useCase.execute(GUILD)).resolves.toMatchObject({ value: ">>" });
    });
  });
});
