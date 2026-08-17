import { describe, expect, it } from "vitest";
import { z } from "zod";

import { openToEveryone } from "#discord/contracts/authorization.contract.js";
import { defineCommand } from "#discord/contracts/command.contract.js";
import type { AutocompleteContext } from "#discord/contracts/context.contract.js";

import { fakeActor } from "#testing/fake.context.js";

/**
 * `defineCommand`, and the autocomplete path it carries.
 *
 * Autocomplete was the last extension point shipped with no caller and no test.
 * The kernel half — turning a discord.js AutocompleteInteraction into this
 * context — is thin plumbing over someone else's library. What a feature author
 * actually writes is the handler, and its failure mode is silent: a box that
 * simply never suggests anything, with no error anywhere to explain it.
 *
 * The other half of that path — the option flag reaching the deployed payload —
 * is asserted in tests/discord/kernel/command-builder.test.ts, where the code
 * that builds it lives.
 */

function context(value: string, name = "query"): AutocompleteContext {
  return { correlationId: "test", actor: fakeActor(), guild: null, focused: { name, value } };
}

describe("defineCommand", () => {
  describe("autocomplete", () => {
    const command = defineCommand({
      name: "search",
      description: "Search things",
      options: [{ type: "string", name: "query", description: "What to find", autocomplete: true }],
      input: z.object({ query: z.string() }),
      authorize: [openToEveryone()],
      handle: () => Promise.resolve({ kind: "none" as const }),
      autocomplete: (ctx) =>
        Promise.resolve([{ name: `${ctx.focused.value} (match)`, value: ctx.focused.value }]),
    });

    it("carries the handler through defineCommand", async () => {
      expect(command.autocomplete).toBeDefined();

      await expect(command.autocomplete?.(context("dragon"))).resolves.toEqual([
        { name: "dragon (match)", value: "dragon" },
      ]);
    });

    it("tells the handler which option is being completed", async () => {
      let focusedName: string | undefined;
      const withFocus = defineCommand({
        name: "search",
        description: "Search things",
        input: z.object({}),
        authorize: [openToEveryone()],
        handle: () => Promise.resolve({ kind: "none" as const }),
        autocomplete: (ctx) => {
          focusedName = ctx.focused.name;
          return Promise.resolve([]);
        },
      });

      await withFocus.autocomplete?.(context("x", "tag"));

      // A command with two autocompleting options needs this to tell them apart.
      expect(focusedName).toBe("tag");
    });

    it("is undefined on a command that does not declare one", () => {
      const plain = defineCommand({
        name: "ping",
        description: "Ping",
        input: z.object({}),
        authorize: [openToEveryone()],
        handle: () => Promise.resolve({ kind: "none" as const }),
      });

      // The pipeline reads exactly this to decide whether to respond at all.
      expect(plain.autocomplete).toBeUndefined();
    });
  });
});
