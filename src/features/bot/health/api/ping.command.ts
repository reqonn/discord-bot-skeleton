import { z } from "zod";

import { openToEveryone } from "#discord/contracts/authorization.contract.js";
import { defineCommand } from "#discord/contracts/command.contract.js";
import type { Response } from "#discord/contracts/response.contract.js";

import type { CheckHealthUseCase } from "../application/check-health.usecase.js";

import { pong } from "./health.presenter.js";

/**
 * `/ping` — is the bot up, and is anything it depends on down?
 *
 * The command everyone runs first, and the one that has to answer when
 * everything else is broken. So it declares `defer: "never"`: acknowledging and
 * then editing is two round trips to Discord where one will do, and this
 * handler's work is a database ping and a cache ping running in parallel —
 * comfortably inside the 3-second budget on any deployment worth keeping.
 *
 * It reports the *gateway* heartbeat and nothing else about its own latency.
 * The obvious alternative — timing the acknowledgement — is a real number that
 * means nothing to a user, and the popular one, `Date.now()` minus the
 * interaction timestamp, subtracts Discord's clock from the local one and
 * routinely reports a negative figure nobody can explain.
 *
 * **No cooldown, deliberately.** People run this repeatedly precisely when they
 * suspect something is wrong, and a bot that answers "too fast, try again in
 * ten seconds" to the fourth attempt has failed at the one moment it was being
 * checked. Two health probes cost less than the reply that reports them.
 */
export function createPingCommand(check: CheckHealthUseCase) {
  return defineCommand({
    name: "ping",
    description: "Check the bot's connection and the health of what it depends on",
    input: z.object({}),
    // The one command that must work for anyone, including whoever is trying to
    // find out why nothing else does.
    authorize: [openToEveryone()],
    defer: "never",
    handle: async (context): Promise<Response> => {
      const report = await check.execute();
      if (!report.ok) return { kind: "error", error: report.error };

      return pong(report.value, context.latency.gatewayMs);
    },
  });
}
