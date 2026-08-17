import { buildCustomId } from "#discord/contracts/custom-id.js";
import type { Response, Section } from "#discord/contracts/response.contract.js";

import { asSnowflake, type Snowflake } from "#shared/types/snowflake.types.js";

import {
  MAX_MESSAGE_LENGTH,
  PLACEHOLDER_NAMES,
  renderWelcome,
  type WelcomeSettings,
} from "../domain/welcome.rules.js";

/**
 * Every screen this feature shows.
 *
 * The editor is one embed, re-rendered after each change and never re-sent —
 * the pipeline updates the message a component came from, so a panel edits
 * itself in place instead of leaving a trail of stale copies behind it.
 *
 * Custom ids are built with `buildCustomId`, never by hand: it enforces the
 * `scope:action:payload` shape and fails loudly past Discord's 100-character
 * cap, rather than letting the API silently reject the whole message.
 */

/** One scope per feature, so routing is unambiguous across the whole bot. */
export const SCOPE = "welcome";

export const Action = {
  editMessage: "edit-message",
  editChannel: "edit-channel",
  reset: "reset",
} as const;

/** The names the forms below collect their answers under. */
export const Field = { message: "message", channel: "channel" } as const;

/**
 * The editor panel.
 *
 * A heading, then the settings, then the controls. The heading says whether
 * anyone is being greeted, because that is the one thing someone opening this
 * screen actually wants to know; everything under it is detail.
 *
 * Colour on a Discord button means something. The two edits are equal choices
 * steering nowhere in particular, so they stay grey; Reset is the one control
 * that destroys what is configured, and red is the only warning a user gets
 * before they press it.
 *
 * Both edits open a form. Nothing is chosen on the panel itself, so the panel
 * has exactly one job — showing what is configured — and every question this
 * bot asks looks the same wherever it is asked from.
 */
export function editor(settings: WelcomeSettings, serverName: string): Response {
  return {
    kind: "info",
    text: settings.enabled
      ? `### Welcome\nGreeting new members in <#${settings.channelId ?? ""}>.`
      : "### Welcome\nNot set up yet — a message and a channel are needed.",
    sections: [configured(settings, serverName), placeholders()],
    actions: [
      { label: "Edit message", customId: buildCustomId(SCOPE, Action.editMessage) },
      { label: "Edit channel", customId: buildCustomId(SCOPE, Action.editChannel) },
      { label: "Reset", customId: buildCustomId(SCOPE, Action.reset), style: "danger" },
    ],
  };
}

function configured(settings: WelcomeSettings, serverName: string): Section {
  return {
    name: "Configuration",
    rows: [
      { name: "Channel", value: settings.channelId === null ? "" : `<#${settings.channelId}>` },
      {
        name: "Message",
        value:
          settings.message === ""
            ? ""
            : asMemberSees(settings.message, serverName, settings.channelId),
      },
    ],
  };
}

function placeholders(): Section {
  return {
    name: "Placeholders",
    rows: [{ name: "Available", value: PLACEHOLDER_NAMES.map((n) => `\`${n}\``).join(" ") }],
  };
}

/**
 * The greeting itself — the server owner's words, and nothing else.
 *
 * Not a success, not an embed, no tick in front of it. Somebody wrote
 * "Welcome {user} to {server}!" and expects that message to arrive; wrapping it
 * in the bot's chrome is the bot talking over the person whose server it is.
 * `kind: "text"` is the only response that renders a mention that actually
 * pings, which is the whole point of `{user}`.
 */
export function greeting(text: string): Response {
  return { kind: "text", content: text, visibility: "public" };
}

export function sent(channelId: Snowflake): Response {
  return { kind: "success", text: `Sent the **welcome message** to <#${channelId}>.` };
}

export function saved(settings: WelcomeSettings): Response {
  // Names what is still missing rather than reporting plain success. A message
  // with no channel is saved and doing nothing, and finding that out when
  // nobody gets greeted is worse than being told now.
  if (settings.channelId === null) {
    return {
      kind: "warning",
      text: "Set the **welcome message**, but no channel is set yet.",
    };
  }

  if (settings.message === "") {
    return {
      kind: "warning",
      text: `Set the **welcome channel** to <#${settings.channelId}>, but no message is set yet.`,
    };
  }

  return {
    kind: "success",
    text: `Set the **welcome message**. New members in <#${settings.channelId}> are greeted now.`,
  };
}

export function reset(): Response {
  return {
    kind: "success",
    text: "Reset the **welcome message**.",
  };
}

/**
 * Shows the message as a member would see it, so the preview cannot lie.
 *
 * The mention is flattened to plain text afterwards: a preview that pings
 * someone is a preview that has done something.
 */
function asMemberSees(message: string, serverName: string, channelId: Snowflake | null): string {
  return renderWelcome(message, {
    userId: asSnowflake("0"),
    userName: "newcomer",
    serverId: asSnowflake("0"),
    serverName,
    memberCount: 42,
    channelId,
  }).replace("<@0>", "@newcomer");
}

/** The form that collects the message text. */
export function messageForm(current: string): Response {
  return {
    kind: "form",
    form: {
      customId: buildCustomId(SCOPE, Action.editMessage),
      title: "Welcome message",
      fields: [
        {
          kind: "text",
          name: Field.message,
          label: "Shown when someone joins",
          help: "The placeholders are listed on the panel behind this form.",
          style: "paragraph",
          required: true,
          maxLength: MAX_MESSAGE_LENGTH,
          placeholder: "Welcome {user} to {server}!",
          ...(current === "" ? {} : { value: current }),
        },
      ],
    },
  };
}

/**
 * The form that chooses the channel.
 *
 * A picker rather than a box asking for an id: Discord fills the list, so the
 * answer cannot be a typo, a channel from another server, or a channel the bot
 * has no business posting in.
 */
export function channelForm(current: Snowflake | null): Response {
  return {
    kind: "form",
    form: {
      customId: buildCustomId(SCOPE, Action.editChannel),
      title: "Welcome channel",
      fields: [
        {
          kind: "pick",
          of: "channel",
          name: Field.channel,
          label: "Where new members are greeted",
          placeholder: "Choose a channel",
          required: true,
          ...(current === null ? {} : { selected: [current] }),
        },
      ],
    },
  };
}
