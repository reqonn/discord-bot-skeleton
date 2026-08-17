import { describe, expect, it } from "vitest";

import { MemoryCache } from "#platform/cache/memory.cache.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import { createPrefixCommand } from "#features/guild/prefix/api/prefix.command.js";
import { GetGuildPrefixUseCase } from "#features/guild/prefix/application/get-guild-prefix.usecase.js";
import { SetGuildPrefixUseCase } from "#features/guild/prefix/application/set-guild-prefix.usecase.js";

import { asSnowflake } from "#shared/types/snowflake.types.js";

import { fakeCommandContext } from "#testing/fake.context.js";
import { MemoryGuildPrefixRepository } from "#testing/memory.guild-prefix.repository.js";

/**
 * The adapter, driven by a plain object.
 *
 * No discord.js, no client, no network — the payoff of the CommandContext
 * boundary. Assertions are on the `Response` view model rather than on embed
 * internals, because rendering is tested once in the design system's own suite
 * and does not need re-testing per feature.
 */

const GUILD = asSnowflake("100000000000000001");

function build(seed: Readonly<Record<string, string>> = {}) {
  const repository = new MemoryGuildPrefixRepository(seed);
  const prefixes = new GetGuildPrefixUseCase(repository, new MemoryCache(new MetricsRegistry()));
  const update = new SetGuildPrefixUseCase(repository, prefixes);
  return { repository, command: createPrefixCommand(prefixes, update, "!") };
}

const inGuild = { guild: { id: GUILD, name: "Test Guild" } };

describe("/prefix", () => {
  it("is restricted to people who can configure the server", () => {
    // A command with no declared policy does not compile. This asserts the
    // decision was deliberate rather than inherited.
    const { command } = build();

    // The policy names the permission it requires, so a failure says which.
    expect(command.authorize.map((policy) => policy.name)).toEqual([
      "inGuild",
      "requirePermission(ManageGuild)",
    ]);
  });

  it("carries no cooldown, because reading and writing a prefix is cheap", () => {
    // A cooldown is for a command whose cost lands on somebody else. This one
    // touches one cached row. See CooldownSpec.
    expect(build().command.cooldown).toBeUndefined();
  });

  describe("showing the prefix", () => {
    it("reports the default when the guild has set none", async () => {
      const { command } = build();
      const { context } = fakeCommandContext(inGuild);

      const response = await command.execute(context, {});

      expect(response).toMatchObject({ kind: "info" });
      expect("text" in response && response.text).toContain("the default");
    });

    it("reports the guild's own prefix once set", async () => {
      const { command } = build({ [GUILD]: ">>" });
      const { context } = fakeCommandContext(inGuild);

      const response = await command.execute(context, {});

      expect("text" in response && response.text).toContain(">>");
    });
  });

  describe("setting the prefix", () => {
    it("stores it and quotes it back", async () => {
      const { command, repository } = build();
      const { context } = fakeCommandContext(inGuild);

      const response = await command.execute(context, { to: "?" });

      expect(response).toMatchObject({ kind: "success" });
      // The reply quotes the prefix that now works, in the voice every
      // assignment in the bot shares: Set **label** to: `value`.
      expect("text" in response && response.text).toContain("`?`");
      await expect(repository.find(GUILD)).resolves.toBe("?");
    });

    it("returns the domain's message when the prefix is rejected", async () => {
      const { command } = build();
      const { context } = fakeCommandContext(inGuild);

      const response = await command.execute(context, { to: "/" });

      expect(response.kind).toBe("error");
      expect(response.kind === "error" && response.error.code).toBe("PREFIX_INVALID");
    });
  });

  describe("resetting", () => {
    it.each(["reset", "RESET", " Reset "])("treats %s as a reset", async (word) => {
      const { command, repository } = build({ [GUILD]: "?" });
      const { context } = fakeCommandContext(inGuild);

      const response = await command.execute(context, { to: word });

      expect(response).toMatchObject({ kind: "success" });
      await expect(repository.find(GUILD)).resolves.toBeUndefined();
    });
  });

  it("rejects input the schema does not accept before any use case runs", async () => {
    const { command, repository } = build();
    const { context } = fakeCommandContext(inGuild);

    // 65 characters — past the schema bound, so validation fails first and the
    // domain rule is never consulted.
    await expect(command.execute(context, { to: "x".repeat(65) })).rejects.toThrow();
    await expect(repository.find(GUILD)).resolves.toBeUndefined();
  });
});
