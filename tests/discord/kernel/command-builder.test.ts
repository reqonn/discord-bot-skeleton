import { ApplicationCommandOptionType } from "discord.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { openToEveryone } from "#discord/contracts/authorization.contract.js";
import { defineCommand, type OptionSpec } from "#discord/contracts/command.contract.js";
import { buildCommandPayload } from "#discord/kernel/command-builder.js";

function command(name: string, description = "test", options: readonly OptionSpec[] = []) {
  return defineCommand({
    name,
    description,
    options,
    input: z.object({}),
    authorize: [openToEveryone()],
    handle: () => Promise.resolve({ kind: "none" as const }),
  });
}

describe("buildCommandPayload", () => {
  it("renders a flat command", () => {
    const [payload] = buildCommandPayload([command("ping", "Check the bot")]);

    expect(payload).toMatchObject({ name: "ping", description: "Check the bot" });
  });

  describe("autocomplete", () => {
    it("marks an option that asked for it", () => {
      // Without this flag Discord never sends an autocomplete interaction, so a
      // perfectly correct handler is simply never called — and nothing errors.
      const [payload] = buildCommandPayload([
        command("search", "Search", [
          { type: "string", name: "query", description: "What to find", autocomplete: true },
        ]),
      ]);

      expect(payload?.options?.[0]).toMatchObject({ name: "query", autocomplete: true });
    });

    it("leaves it off an option that did not", () => {
      const [payload] = buildCommandPayload([
        command("echo", "Echo", [{ type: "string", name: "text", description: "Text" }]),
      ]);

      expect(payload?.options?.[0]).not.toHaveProperty("autocomplete");
    });

    it("marks an integer option too, not only strings", () => {
      const [payload] = buildCommandPayload([
        command("pick", "Pick", [
          { type: "integer", name: "index", description: "Which", autocomplete: true },
        ]),
      ]);

      expect(payload?.options?.[0]).toMatchObject({ name: "index", autocomplete: true });
    });
  });

  it("groups subcommands under one root", () => {
    // Descriptors are flat — "ticket open", "ticket close" — because that is
    // how they are invoked and logged. Discord wants a tree.
    const payload = buildCommandPayload([command("ticket open"), command("ticket close")]);

    expect(payload).toHaveLength(1);
    expect(payload[0]?.name).toBe("ticket");
    expect(payload[0]?.options?.map((o) => o.name).sort()).toEqual(["close", "open"]);
    expect(payload[0]?.options?.[0]?.type).toBe(ApplicationCommandOptionType.Subcommand);
  });

  it("uses the root's own description when a bare root exists", () => {
    const payload = buildCommandPayload([
      command("ticket open"),
      command("ticket", "Manage support tickets"),
    ]);

    expect(payload[0]?.description).toBe("Manage support tickets");
  });

  it("invents a description when no bare root was declared", () => {
    // Discord rejects a command without one, so a placeholder beats a failed
    // deployment.
    const payload = buildCommandPayload([command("ticket open")]);

    expect(payload[0]?.description).toBeTruthy();
  });

  it("builds subcommand groups three levels deep", () => {
    const payload = buildCommandPayload([
      command("config set prefix"),
      command("config set colour"),
    ]);

    const group = payload[0]?.options?.[0];
    expect(group).toMatchObject({
      type: ApplicationCommandOptionType.SubcommandGroup,
      name: "set",
    });
    expect(
      group?.type === ApplicationCommandOptionType.SubcommandGroup && group.options,
    ).toHaveLength(2);
  });

  it("keeps separate roots separate", () => {
    const payload = buildCommandPayload([command("ping"), command("ticket open")]);

    expect(payload.map((c) => c.name).sort()).toEqual(["ping", "ticket"]);
  });

  describe("options", () => {
    it("maps each declared type", () => {
      const payload = buildCommandPayload([
        command("test", "t", [
          { type: "string", name: "text", description: "d", required: true },
          { type: "integer", name: "count", description: "d" },
          { type: "boolean", name: "flag", description: "d" },
          { type: "user", name: "who", description: "d" },
          { type: "channel", name: "where", description: "d" },
          { type: "role", name: "role", description: "d" },
        ]),
      ]);

      expect(payload[0]?.options?.map((o) => o.type)).toEqual([
        ApplicationCommandOptionType.String,
        ApplicationCommandOptionType.Integer,
        ApplicationCommandOptionType.Boolean,
        ApplicationCommandOptionType.User,
        ApplicationCommandOptionType.Channel,
        ApplicationCommandOptionType.Role,
      ]);
    });

    it("carries required through, defaulting to optional", () => {
      const payload = buildCommandPayload([
        command("test", "t", [
          { type: "string", name: "a", description: "d", required: true },
          { type: "string", name: "b", description: "d" },
        ]),
      ]);

      expect(payload[0]?.options?.map((o) => o.required)).toEqual([true, false]);
    });

    it("carries string length bounds", () => {
      const payload = buildCommandPayload([
        command("test", "t", [
          { type: "string", name: "a", description: "d", minLength: 3, maxLength: 20 },
        ]),
      ]);

      expect(payload[0]?.options?.[0]).toMatchObject({ min_length: 3, max_length: 20 });
    });

    it("attaches options to the subcommand, not the root", () => {
      const payload = buildCommandPayload([
        command("ticket open", "Open one", [
          { type: "string", name: "subject", description: "d", required: true },
        ]),
      ]);

      const subcommand = payload[0]?.options?.[0];
      expect(subcommand?.name).toBe("open");
      expect(
        subcommand?.type === ApplicationCommandOptionType.Subcommand && subcommand.options,
      ).toHaveLength(1);
    });
  });

  it("returns nothing for no commands", () => {
    expect(buildCommandPayload([])).toEqual([]);
  });
});
