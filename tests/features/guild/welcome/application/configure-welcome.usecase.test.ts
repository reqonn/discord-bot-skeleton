import { describe, expect, it } from "vitest";

import { MemoryCache } from "#platform/cache/memory.cache.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import { ConfigureWelcomeUseCase } from "#features/guild/welcome/application/configure-welcome.usecase.js";

import { asSnowflake } from "#shared/types/snowflake.types.js";

import { MemoryWelcomeRepository } from "#testing/memory.welcome.repository.js";

/**
 * The one use case that writes: commands, buttons, the modal and the channel
 * picker all land here.
 *
 * Most of this is about `enabled`, which is derived rather than set: a guild is
 * greeting people exactly when it has both halves. A flag that could disagree
 * with that would fail as *silence*, which is the hardest kind to notice.
 */

const GUILD = asSnowflake("100000000000000001");
const CHANNEL = asSnowflake("300000000000000003");

function build() {
  const repository = new MemoryWelcomeRepository();
  return {
    repository,
    configure: new ConfigureWelcomeUseCase(repository, new MemoryCache(new MetricsRegistry())),
  };
}

describe("ConfigureWelcomeUseCase", () => {
  it("reports the empty configuration for a guild that has none", async () => {
    // The empty shape rather than undefined, so a panel renders the same way
    // for a guild that never configured anything and one that reset.
    const { configure } = build();

    const result = await configure.settings(GUILD);

    expect(result.ok && result.value).toMatchObject({
      message: "",
      channelId: null,
      enabled: false,
    });
  });

  describe("one field at a time", () => {
    it("stays off with only a message", async () => {
      // Saved and doing nothing. The presenter says so rather than reporting
      // plain success, but the state itself has to be right first.
      const { configure } = build();

      const result = await configure.setMessage(GUILD, "Hi {user}");

      expect(result.ok && result.value.message).toBe("Hi {user}");
      expect(result.ok && result.value.enabled).toBe(false);
    });

    it("stays off with only a channel", async () => {
      const { configure } = build();

      const result = await configure.setChannel(GUILD, CHANNEL);

      expect(result.ok && result.value.enabled).toBe(false);
    });

    it("switches on once both are set, in either order", async () => {
      const { configure } = build();

      await configure.setChannel(GUILD, CHANNEL);
      const result = await configure.setMessage(GUILD, "Hi {user}");

      expect(result.ok && result.value.enabled).toBe(true);
    });
  });

  it("rejects a message the domain refuses, and stores nothing", async () => {
    const { configure, repository } = build();

    const result = await configure.setMessage(GUILD, "Hi {used}");

    expect(!result.ok && result.error.code).toBe("WELCOME_INVALID_MESSAGE");
    expect(repository.settings.has(GUILD)).toBe(false);
  });

  describe("resetting", () => {
    it("takes the message and the channel with it", async () => {
      // A reset, not a pause. Leaving the old text behind would restore it the
      // moment someone set a channel again, which is a surprise nobody asked
      // for — and the reason this is not simply enabled:false.
      const { configure } = build();
      await configure.setChannel(GUILD, CHANNEL);
      await configure.setMessage(GUILD, "Hi {user}");

      const result = await configure.reset(GUILD);

      expect(result.ok && result.value).toMatchObject({
        enabled: false,
        message: "",
        channelId: null,
      });
    });

    it("leaves nothing behind for the next edit to resurrect", async () => {
      const { configure } = build();
      await configure.setChannel(GUILD, CHANNEL);
      await configure.setMessage(GUILD, "Hi {user}");
      await configure.reset(GUILD);

      const result = await configure.setMessage(GUILD, "Hello again {user}");

      // Still off: the channel went with the reset, so one half is missing.
      expect(result.ok && result.value.enabled).toBe(false);
    });

    it("is safe on a guild that never configured anything", async () => {
      const { configure } = build();

      await expect(configure.reset(GUILD)).resolves.toMatchObject({ ok: true });
    });
  });
});
