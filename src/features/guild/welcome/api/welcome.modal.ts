import { requireGuild, requirePermission } from "#discord/contracts/authorization.contract.js";
import { defineModal } from "#discord/contracts/component.contract.js";
import type { Response } from "#discord/contracts/response.contract.js";

import type { ConfigureWelcomeUseCase } from "../application/configure-welcome.usecase.js";

import { Action, editor, Field, SCOPE } from "./welcome.presenter.js";

/**
 * What the two forms do when they come back.
 *
 * Each is registered under the same scope and action as the button that opened
 * it, because the modal's custom id is the one the button supplied — so the
 * round trip needs no extra bookkeeping to find its way home.
 *
 * Both return the panel, which re-renders the message the form was opened from:
 * a modal raised by a component still belongs to that component's message, and
 * the pipeline knows it.
 *
 * Neither repeats validation. The use case runs the domain rule and this
 * returns whatever it decided; a second check in the adapter is a second place
 * for the rule to be slightly different.
 */
export function createWelcomeModals(configure: ConfigureWelcomeUseCase) {
  const message = defineModal({
    scope: SCOPE,
    action: Action.editMessage,
    authorize: [requirePermission("ManageGuild")],
    handle: async (context): Promise<Response> => {
      const guild = requireGuild(context, "/welcome edit");
      const updated = await configure.setMessage(guild.id, context.values[Field.message] ?? "");

      return updated.ok
        ? editor(updated.value, guild.name)
        : { kind: "error", error: updated.error };
    },
  });

  const channel = defineModal({
    scope: SCOPE,
    action: Action.editChannel,
    authorize: [requirePermission("ManageGuild")],
    handle: async (context): Promise<Response> => {
      const guild = requireGuild(context, "/welcome edit");
      const chosen = context.selected[Field.channel]?.[0];

      // The picker is required, so Discord will not submit the form without a
      // choice. This is the belt to that braces: the answer arrives over the
      // wire, and the wire is not a thing to trust.
      if (chosen === undefined) {
        const settings = await configure.settings(guild.id);
        return settings.ok
          ? editor(settings.value, guild.name)
          : { kind: "error", error: settings.error };
      }

      const updated = await configure.setChannel(guild.id, chosen);
      return updated.ok
        ? editor(updated.value, guild.name)
        : { kind: "error", error: updated.error };
    },
  });

  return [message, channel];
}
