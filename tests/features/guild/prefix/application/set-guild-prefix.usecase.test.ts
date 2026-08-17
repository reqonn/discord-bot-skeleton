import { describe, expect, it } from "vitest";

import { MemoryCache } from "#platform/cache/memory.cache.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import { GetGuildPrefixUseCase } from "#features/guild/prefix/application/get-guild-prefix.usecase.js";
import { SetGuildPrefixUseCase } from "#features/guild/prefix/application/set-guild-prefix.usecase.js";

import { asSnowflake } from "#shared/types/snowflake.types.js";

import { MemoryGuildPrefixRepository } from "#testing/memory.guild-prefix.repository.js";

const GUILD = asSnowflake("100000000000000001");

function build(seed: Readonly<Record<string, string>> = {}) {
  const repository = new MemoryGuildPrefixRepository(seed);
  const prefixes = new GetGuildPrefixUseCase(repository, new MemoryCache(new MetricsRegistry()));
  return { repository, prefixes, update: new SetGuildPrefixUseCase(repository, prefixes) };
}

describe("SetGuildPrefixUseCase", () => {
  it("stores a valid prefix", async () => {
    const { update, repository } = build();

    const result = await update.set(GUILD, "?");

    expect(result.ok && result.value).toBe("?");
    await expect(repository.find(GUILD)).resolves.toBe("?");
  });

  it("stores the trimmed form the domain returned, not the raw input", async () => {
    // The use case propagates the domain's decision rather than the argument
    // it was handed — otherwise the rule and the stored value could disagree.
    const { update, repository } = build();

    await update.set(GUILD, "  ?  ");

    await expect(repository.find(GUILD)).resolves.toBe("?");
  });

  describe("when the domain rejects it", () => {
    it("returns the failure instead of throwing", async () => {
      const { update } = build();

      const result = await update.set(GUILD, "/");

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe("PREFIX_INVALID");
    });

    it("writes nothing", async () => {
      // The important half. A rejected change must leave storage untouched,
      // not half-applied.
      const { update, repository } = build({ [GUILD]: "?" });

      await update.set(GUILD, "! x");

      await expect(repository.find(GUILD)).resolves.toBe("?");
    });
  });

  describe("clearing", () => {
    it("removes the override", async () => {
      const { update, repository } = build({ [GUILD]: "?" });

      await update.clear(GUILD);

      // Absence *is* the representation of "use the default" — there is no
      // second way to say it, so the two can never disagree.
      await expect(repository.find(GUILD)).resolves.toBeUndefined();
    });

    it("is safe when there was nothing to clear", async () => {
      const { update } = build();

      await expect(update.clear(GUILD)).resolves.toMatchObject({ ok: true });
    });
  });

  describe("cache coherence", () => {
    it("makes a write visible to the next read", async () => {
      // The bug this prevents: set the prefix, then have the bot keep using
      // the old one for a minute because nothing dropped the cached entry.
      const { update, prefixes } = build({ [GUILD]: "?" });
      await prefixes.execute(GUILD);

      await update.set(GUILD, ">>");

      await expect(prefixes.execute(GUILD)).resolves.toMatchObject({ value: ">>" });
    });

    it("makes a clear visible to the next read", async () => {
      const { update, prefixes } = build({ [GUILD]: "?" });
      await prefixes.execute(GUILD);

      await update.clear(GUILD);

      await expect(prefixes.execute(GUILD)).resolves.toMatchObject({ value: null });
    });
  });
});
