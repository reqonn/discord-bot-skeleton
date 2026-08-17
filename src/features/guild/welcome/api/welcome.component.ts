import { requireGuild, requirePermission } from "#discord/contracts/authorization.contract.js";
import { defineComponent } from "#discord/contracts/component.contract.js";
import type { Response } from "#discord/contracts/response.contract.js";

import type { ConfigureWelcomeUseCase } from "../application/configure-welcome.usecase.js";

import { Action, channelForm, editor, messageForm, SCOPE } from "./welcome.presenter.js";

/**
 * The editor's three buttons.
 *
 * Two of them open a form and one acts. Each is the same three steps a command
 * takes: authorize, call a use case, present. What they return replaces the
 * message they came from, because the pipeline updates a component's own
 * message rather than posting a reply — so the panel edits itself, and a
 * session lasts as long as the message does.
 *
 * Nothing is held between clicks. The custom ids carry no payload and there is
 * no draft anywhere; every handler reads the current settings and writes them
 * back. A button clicked an hour after a deploy therefore still works, which
 * in-memory editor state never manages.
 *
 * `ownerOnly` defaults to true, so a second person clicking someone's panel is
 * refused by the pipeline before any of this runs — and `requirePermission`
 * refuses anyone who has lost the permission since it was opened.
 */

const MANAGERS = [requirePermission("ManageGuild")] as const;

export function createWelcomeComponents(configure: ConfigureWelcomeUseCase) {
  const editMessage = defineComponent({
    scope: SCOPE,
    action: Action.editMessage,
    authorize: [...MANAGERS],
    // A modal must be the first reply to an interaction, so nothing may
    // acknowledge before this handler does.
    defer: "never",
    handle: async (context): Promise<Response> => {
      const guild = requireGuild(context, "/welcome edit");
      const settings = await configure.settings(guild.id);
      if (!settings.ok) return { kind: "error", error: settings.error };

      return messageForm(settings.value.message);
    },
  });

  const editChannel = defineComponent({
    scope: SCOPE,
    action: Action.editChannel,
    authorize: [...MANAGERS],
    defer: "never",
    handle: async (context): Promise<Response> => {
      const guild = requireGuild(context, "/welcome edit");
      const settings = await configure.settings(guild.id);
      if (!settings.ok) return { kind: "error", error: settings.error };

      // The same popup form the message uses, holding a channel picker instead
      // of a text box. One shape for every question the bot asks.
      return channelForm(settings.value.channelId);
    },
  });

  const reset = defineComponent({
    scope: SCOPE,
    action: Action.reset,
    authorize: [...MANAGERS],
    handle: async (context): Promise<Response> => {
      const guild = requireGuild(context, "/welcome edit");
      const cleared = await configure.reset(guild.id);

      // Back to the empty panel rather than a confirmation, so the result of
      // the reset is the thing on screen.
      return cleared.ok
        ? editor(cleared.value, guild.name)
        : { kind: "error", error: cleared.error };
    },
  });

  return [editMessage, editChannel, reset];
}
