import { PermissionsBitField, type Message, type PermissionResolvable } from "discord.js";

import { asSnowflake } from "../../shared/types/snowflake.types.js";
import type { Actor, ChannelRef, GuildRef, PermissionName } from "../contracts/actor.contract.js";
import type { CommandContext, Latency } from "../contracts/context.contract.js";
import type { Response, Visibility } from "../contracts/response.contract.js";
import { renderResponse, toPayload, type RenderOptions } from "../ui/render.js";

import type { Responder } from "./context-factory.js";

/**
 * The message-command half of the containment boundary.
 *
 * Everything here exists so a handler cannot tell whether it was reached by
 * `/ping` or `!ping`: it receives the same CommandContext, returns the same
 * Response, and never learns that a Message was involved.
 *
 * Two differences are real and cannot be hidden, so they are stated rather than
 * faked:
 *
 *   - **Nothing is private.** A message reply is visible to the channel.
 *     `visibility: "ephemeral"` is honoured on the slash path and ignored here,
 *     because there is no mechanism for it.
 *   - **Modals cannot open.** Discord only shows a modal in response to an
 *     interaction. A `form` response arriving here is answered with a notice
 *     pointing at the slash command instead of failing silently.
 */

const PERMISSION_FLAGS: Record<PermissionName, PermissionResolvable> = {
  Administrator: PermissionsBitField.Flags.Administrator,
  ManageGuild: PermissionsBitField.Flags.ManageGuild,
  ManageChannels: PermissionsBitField.Flags.ManageChannels,
  ManageMessages: PermissionsBitField.Flags.ManageMessages,
  ManageRoles: PermissionsBitField.Flags.ManageRoles,
  ModerateMembers: PermissionsBitField.Flags.ModerateMembers,
  KickMembers: PermissionsBitField.Flags.KickMembers,
  BanMembers: PermissionsBitField.Flags.BanMembers,
};

const PERMISSION_NAMES = Object.keys(PERMISSION_FLAGS) as PermissionName[];

export function buildMessageActor(message: Message): Actor {
  const permissions = new Set<PermissionName>();
  const { member } = message;

  if (member !== null) {
    // Channel-aware, matching the slash path: guild-level roles are not the
    // whole story once channel overwrites exist, and an authorization policy
    // must not answer differently depending on how the command was typed.
    const effective = message.channel.isDMBased()
      ? member.permissions
      : (member.permissionsIn(message.channel) ?? member.permissions);

    for (const name of PERMISSION_NAMES) {
      if (effective.has(PERMISSION_FLAGS[name])) permissions.add(name);
    }
  }

  return {
    userId: asSnowflake(message.author.id),
    displayName: member?.displayName ?? message.author.displayName,
    isBot: message.author.bot,
    roleIds: member === null ? [] : member.roles.cache.map((role) => asSnowflake(role.id)),
    permissions,
    isGuildOwner: member !== null && message.guild?.ownerId === message.author.id,
  };
}

function buildGuild(message: Message): GuildRef | null {
  const { guild } = message;
  return guild === null ? null : { id: asSnowflake(guild.id), name: guild.name };
}

function buildChannel(message: Message): ChannelRef {
  const { channel } = message;

  return {
    id: asSnowflake(channel.id),
    name: "name" in channel ? (channel.name ?? "unnamed") : "direct-message",
    parentId:
      "parentId" in channel && channel.parentId !== null ? asSnowflake(channel.parentId) : null,
  };
}

/**
 * Replies to a message, presenting the same surface as the interaction one.
 *
 * `defer` sends a typing indicator. That is the honest analogue: it tells the
 * user something is happening and, being a real REST call, it gives the same
 * round-trip figure the interaction path reports — so `!ping` measures a real
 * request rather than inventing a number.
 */
export class MessageResponder implements Responder {
  private acknowledged = false;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly message: Message,
    private readonly renderOptions: RenderOptions,
  ) {}

  get hasAcknowledged(): boolean {
    return this.acknowledged;
  }

  defer(_visibility?: Visibility): Promise<void> {
    if (this.acknowledged) return this.pending;

    this.acknowledged = true;
    // A group DM the bot was added to is not sendable, so there is nothing to
    // type into — and no acknowledgement round trip to report either.
    if (!this.message.channel.isSendable()) return this.pending;

    this.pending = this.message.channel
      .sendTyping()
      .then(() => undefined)
      .catch(() => {
        // Missing permission to type is not a reason to fail the command; the
        // reply itself will report anything that actually matters.
      });

    return this.pending;
  }

  /**
   * Posts into the channel — it does not reply to the message.
   *
   * `message.reply()` attaches a reply reference, which puts a "replying to…"
   * header on every answer and, by default, pings the author of a message they
   * are looking at. In a busy channel that is a wall of quote headers and a
   * notification for something the person just did themselves. A plain send
   * lands in the same place with none of that.
   */
  async respond(response: Response): Promise<void> {
    await this.pending;

    if (response.kind === "none") return;
    if (!this.message.channel.isSendable()) return;

    if (response.kind === "form") {
      // Discord only opens a modal in response to an interaction. Saying so
      // beats the silent nothing a user would otherwise get.
      await this.message.channel.send({
        content: "That command needs the slash version — try it as a `/` command.",
      });
      return;
    }

    await this.message.channel.send(toPayload(renderResponse(response, this.renderOptions)));
  }

  async followUp(response: Response): Promise<void> {
    if (response.kind === "form" || response.kind === "none") return;

    const rendered = renderResponse(response, this.renderOptions);
    if (!this.message.channel.isSendable()) return;

    await this.message.channel.send(toPayload(rendered));
  }
}

export function buildMessageContext(
  message: Message,
  correlationId: string,
  responder: MessageResponder,
): CommandContext {
  const startedAt = performance.now();
  const heartbeat = message.client.ws.ping;

  const latency: Latency = {
    gatewayMs: Number.isFinite(heartbeat) && heartbeat >= 0 ? Math.round(heartbeat) : null,
    elapsedMs: () => Math.round(performance.now() - startedAt),
  };

  return {
    correlationId,
    actor: buildMessageActor(message),
    guild: buildGuild(message),
    channel: buildChannel(message),
    // Messages carry no locale. The guild's preferred locale is the closest
    // honest answer, and en-GB the fallback the slash path would have used.
    locale: message.guild?.preferredLocale ?? "en-GB",
    latency,
    defer: (visibility) => responder.defer(visibility),
    followUp: (response) => responder.followUp(response),
  };
}
