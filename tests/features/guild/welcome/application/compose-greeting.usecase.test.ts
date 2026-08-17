import { describe, expect, it } from "vitest";

import { MemoryCache } from "#platform/cache/memory.cache.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import { ComposeGreetingUseCase } from "#features/guild/welcome/application/compose-greeting.usecase.js";
import { ConfigureWelcomeUseCase } from "#features/guild/welcome/application/configure-welcome.usecase.js";

import { asSnowflake } from "#shared/types/snowflake.types.js";

import { MemoryWelcomeRepository } from "#testing/memory.welcome.repository.js";

/**
 * Working out how someone should be greeted.
 *
 * No fakes beyond storage, because the use case sends nothing — it decides what
 * to say and where, and the adapter in `api/` does the posting. That split is
 * what makes this testable without a gateway, and it is enforced: an earlier
 * version reached for the messenger here and the architecture check rejected it.
 */

const GUILD = asSnowflake("100000000000000001");
const MEMBER = asSnowflake("200000000000000002");
const CHANNEL = asSnowflake("300000000000000003");

const JOINED = {
  guildId: GUILD,
  serverName: "Test Guild",
  userId: MEMBER,
  userName: "ana",
  memberCount: 42,
};

function build(configured = true) {
  const repository = new MemoryWelcomeRepository();
  if (configured) {
    repository.settings.set(GUILD, {
      guildId: GUILD,
      channelId: CHANNEL,
      message: "Welcome {user} ({user.name}) to {server} — member {server.count}!",
      enabled: true,
    });
  }
  const configure = new ConfigureWelcomeUseCase(repository, new MemoryCache(new MetricsRegistry()));
  return { repository, configure, compose: new ComposeGreetingUseCase(configure) };
}

describe("ComposeGreetingUseCase", () => {
  it("substitutes every placeholder", async () => {
    const { compose } = build();

    const result = await compose.execute(JOINED);

    expect(result.ok && result.value.text).toBe(
      `Welcome <@${MEMBER}> (ana) to Test Guild — member 42!`,
    );
  });

  it("says where it goes", async () => {
    const { compose } = build();

    const result = await compose.execute(JOINED);

    expect(result.ok && result.value.channelId).toBe(CHANNEL);
  });

  describe("when there is nothing to send", () => {
    it("declines for a guild that never configured one", async () => {
      // The common case by far: the join event fires for every guild the bot is
      // in, and most will never have set this up. It must be a quiet decline,
      // not an error worth logging.
      const { compose } = build(false);

      const result = await compose.execute(JOINED);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toBe("WELCOME_NOT_READY");
      expect(!result.ok && result.error.severity).toBe("expected");
    });

    it("declines when greeting was switched off", async () => {
      const { repository, compose } = build();
      const current = repository.settings.get(GUILD);
      repository.settings.set(GUILD, { ...current!, enabled: false });

      await expect(compose.execute(JOINED)).resolves.toMatchObject({ ok: false });
    });

    it("declines when the channel is gone from the config", async () => {
      const { repository, compose } = build();
      const current = repository.settings.get(GUILD);
      repository.settings.set(GUILD, { ...current!, channelId: null });

      await expect(compose.execute(JOINED)).resolves.toMatchObject({ ok: false });
    });
  });
});
