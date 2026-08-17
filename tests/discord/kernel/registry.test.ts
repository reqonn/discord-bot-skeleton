import { describe, expect, it } from "vitest";
import { z } from "zod";

import { openToEveryone } from "#discord/contracts/authorization.contract.js";
import { defineCommand } from "#discord/contracts/command.contract.js";
import { defineComponent, defineModal } from "#discord/contracts/component.contract.js";
import { defineEvent } from "#discord/contracts/event.contract.js";
import { InteractionRegistry } from "#discord/kernel/registry.js";

function command(name: string) {
  return defineCommand({
    name,
    description: "test",
    input: z.object({}),
    authorize: [openToEveryone()],
    handle: () => Promise.resolve({ kind: "none" as const }),
  });
}

function component(scope: string, action: string) {
  return defineComponent({
    scope,
    action,
    authorize: [openToEveryone()],
    handle: () => Promise.resolve({ kind: "none" as const }),
  });
}

describe("InteractionRegistry", () => {
  it("finds a registered command by name", () => {
    const registry = new InteractionRegistry();
    const ping = command("ping");
    registry.registerCommand(ping, "health");

    expect(registry.findCommand("ping")).toBe(ping);
  });

  it("returns undefined for an unknown command, so the pipeline can fail closed", () => {
    expect(new InteractionRegistry().findCommand("nope")).toBeUndefined();
  });

  it("keeps subcommands distinct from their root", () => {
    const registry = new InteractionRegistry();
    registry.registerCommand(command("ticket"), "tickets");
    registry.registerCommand(command("ticket open"), "tickets");

    expect(registry.findCommand("ticket")?.name).toBe("ticket");
    expect(registry.findCommand("ticket open")?.name).toBe("ticket open");
  });

  describe("collisions are boot failures", () => {
    // Silent shadowing is the normal failure mode of registries like this, and
    // it is miserable to diagnose: the command exists, it responds, and it runs
    // the wrong code.

    it("refuses two commands with the same name", () => {
      const registry = new InteractionRegistry();
      registry.registerCommand(command("ping"), "health");

      expect(() => {
        registry.registerCommand(command("ping"), "diagnostics");
      }).toThrow(/Duplicate command "ping"/);
    });

    it("names the feature that caused it", () => {
      const registry = new InteractionRegistry();
      registry.registerCommand(command("ping"), "health");

      // The message has to be actionable at 3am, which means naming the
      // feature rather than only the command.
      expect(() => {
        registry.registerCommand(command("ping"), "diagnostics");
      }).toThrow(/diagnostics/);
    });

    it("refuses two components with the same scope and action", () => {
      const registry = new InteractionRegistry();
      registry.registerComponent(component("tickets", "close"), "tickets");

      expect(() => {
        registry.registerComponent(component("tickets", "close"), "other");
      }).toThrow(/Duplicate component "tickets:close"/);
    });

    it("allows the same action under a different scope", () => {
      const registry = new InteractionRegistry();
      registry.registerComponent(component("tickets", "close"), "tickets");

      expect(() => {
        registry.registerComponent(component("threads", "close"), "threads");
      }).not.toThrow();
    });

    it("refuses two modals with the same scope and action", () => {
      const registry = new InteractionRegistry();
      const modal = defineModal({
        scope: "tickets",
        action: "reason",
        authorize: [openToEveryone()],
        handle: () => Promise.resolve({ kind: "none" as const }),
      });

      registry.registerModal(modal, "tickets");

      expect(() => {
        registry.registerModal(modal, "tickets");
      }).toThrow(/Duplicate modal/);
    });
  });

  describe("events", () => {
    it("allows several subscribers — the one case without a collision", () => {
      const registry = new InteractionRegistry();
      registry.registerEvent(
        defineEvent({ event: "guildJoined", name: "welcome", handle: () => Promise.resolve() }),
        "welcome",
      );
      registry.registerEvent(
        defineEvent({ event: "guildJoined", name: "analytics", handle: () => Promise.resolve() }),
        "analytics",
      );

      expect(registry.subscribersFor("guildJoined")).toHaveLength(2);
    });

    it("returns an empty list for an event nothing subscribes to", () => {
      expect(new InteractionRegistry().subscribersFor("channelDeleted")).toEqual([]);
    });
  });

  it("lists every command, for deployment", () => {
    const registry = new InteractionRegistry();
    registry.registerCommand(command("ping"), "health");
    registry.registerCommand(command("ticket open"), "tickets");

    expect(
      registry
        .commands()
        .map((c) => c.name)
        .sort(),
    ).toEqual(["ping", "ticket open"]);
  });

  it("counts what it holds, for the startup log", () => {
    const registry = new InteractionRegistry();
    registry.registerCommand(command("ping"), "health");
    registry.registerComponent(component("tickets", "close"), "tickets");

    expect(registry.counts()).toEqual({ commands: 1, components: 1, modals: 0, events: 0 });
  });
});
