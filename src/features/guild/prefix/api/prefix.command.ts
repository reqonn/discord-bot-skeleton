import { z } from "zod";

import {
  inGuild,
  requireGuild,
  requirePermission,
} from "#discord/contracts/authorization.contract.js";
import { defineCommand } from "#discord/contracts/command.contract.js";
import type { Response } from "#discord/contracts/response.contract.js";

import type { GetGuildPrefixUseCase } from "../application/get-guild-prefix.usecase.js";
import type { SetGuildPrefixUseCase } from "../application/set-guild-prefix.usecase.js";
import { MAX_PREFIX_LENGTH } from "../domain/prefix.rules.js";

import { prefixInForce, prefixReset, prefixUpdated } from "./prefix.presenter.js";

/**
 * `/prefix` — show or change this server's message-command prefix.
 *
 * One command doing three things, because Discord will not let a command be
 * both directly invocable and a parent of subcommands:
 *
 *   /prefix            show what is in force
 *   /prefix to:?       set it
 *   /prefix to:reset   go back to the default
 *
 * `!prefix`, `!prefix ?` and `!prefix reset` do the same, from this same
 * descriptor — positional arguments map onto the declared options in order.
 *
 * Notice what this file does *not* contain: no rule (that is `domain/`), no SQL
 * (that is `infrastructure/`), and no copy (that is `prefix.presenter.ts`).
 * What is left is policy and orchestration, which is all a command should be —
 * and it is what keeps this file the same size at ten screens as at one.
 */

/** The word that means "remove the override" rather than "set it to this". */
const RESET = "reset";

export function createPrefixCommand(
  prefixes: GetGuildPrefixUseCase,
  update: SetGuildPrefixUseCase,
  /** The configured fallback, shown when a guild has set nothing. */
  defaultPrefix: string,
) {
  return defineCommand({
    name: "prefix",
    description: "Show or change the prefix for message commands",
    options: [
      {
        type: "string",
        name: "to",
        description: `New prefix (max ${String(MAX_PREFIX_LENGTH)}), or "${RESET}" for the default`,
      },
    ],
    input: z.object({ to: z.string().max(64).optional() }),
    // Guild-only, and only for people who can already configure the server.
    // Reading is as restricted as writing deliberately: the answer interests
    // nobody else, and one policy is easier to reason about than two.
    authorize: [inGuild(), requirePermission("ManageGuild")],
    handle: async (context, input): Promise<Response> => {
      const guild = requireGuild(context, "/prefix");

      if (input.to === undefined) {
        const current = await prefixes.execute(guild.id);
        if (!current.ok) return { kind: "error", error: current.error };

        return prefixInForce(current.value ?? defaultPrefix, current.value === null);
      }

      if (input.to.trim().toLowerCase() === RESET) {
        const cleared = await update.clear(guild.id);
        return cleared.ok ? prefixReset(defaultPrefix) : { kind: "error", error: cleared.error };
      }

      const result = await update.set(guild.id, input.to);
      // The compiler will not let this branch be skipped, which is the whole
      // reason use cases return Result rather than throwing.
      if (!result.ok) return { kind: "error", error: result.error };

      return prefixUpdated(result.value);
    },
  });
}
