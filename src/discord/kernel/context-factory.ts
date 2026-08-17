import {
  PermissionsBitField,
  type BaseInteraction,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalMessageModalSubmitInteraction,
  type ModalSubmitInteraction,
  type PermissionResolvable,
} from "discord.js";

import { asSnowflake, type Snowflake } from "../../shared/types/snowflake.types.js";
import type { Actor, ChannelRef, GuildRef, PermissionName } from "../contracts/actor.contract.js";
import type {
  CommandContext,
  ComponentContext,
  Latency,
  ModalContext,
} from "../contracts/context.contract.js";
import type { Response, Visibility } from "../contracts/response.contract.js";
import { renderForm, renderResponse, toPayload, type RenderOptions } from "../ui/render.js";

/**
 * The permissions we model, paired with their discord.js flag.
 *
 * Explicit rather than derived, so adding a permission to the contract is a
 * two-line change the compiler checks, and an unmapped one cannot silently
 * evaluate to "not granted".
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

/**
 * Translates a discord.js interaction into the framework-agnostic context.
 *
 * This is the containment boundary made real: everything a handler is allowed
 * to know is materialised here, and nothing else crosses. It is deliberately
 * eager — permissions are resolved into a plain Set rather than left as a lazy
 * bitfield — so an authorization check downstream costs no API call and no
 * await, which is what keeps permission checks off the latency budget.
 */
export function buildActor(interaction: BaseInteraction): Actor {
  const permissions = new Set<PermissionName>();
  const member = interaction.inCachedGuild() ? interaction.member : null;

  if (member !== null) {
    // memberPermissions is channel-aware; guild-level roles are not the whole
    // story once channel overwrites exist.
    const effective = interaction.memberPermissions ?? member.permissions;
    for (const name of PERMISSION_NAMES) {
      if (effective.has(PERMISSION_FLAGS[name])) permissions.add(name);
    }
  }

  return {
    userId: asSnowflake(interaction.user.id),
    displayName: member?.displayName ?? interaction.user.displayName,
    isBot: interaction.user.bot,
    roleIds: member === null ? [] : member.roles.cache.map((role) => asSnowflake(role.id)),
    permissions,
    isGuildOwner: member !== null && interaction.guild?.ownerId === interaction.user.id,
  };
}

function buildGuild(interaction: BaseInteraction): GuildRef | null {
  const { guild } = interaction;
  return guild === null ? null : { id: asSnowflake(guild.id), name: guild.name };
}

function buildChannel(interaction: BaseInteraction): ChannelRef {
  const { channel } = interaction;

  if (channel === null) {
    // A direct message before the channel is cached. Commands that need a real
    // channel declare inGuild(), which rejects before a handler sees this.
    return {
      id: asSnowflake(interaction.channelId ?? "0"),
      name: "direct-message",
      parentId: null,
    };
  }

  return {
    id: asSnowflake(channel.id),
    name: "name" in channel ? (channel.name ?? "unnamed") : "direct-message",
    parentId:
      "parentId" in channel && channel.parentId !== null ? asSnowflake(channel.parentId) : null,
  };
}

/**
 * Reads the connection timings off the client.
 *
 * The only place either number is obtained, which is what lets a feature report
 * them without importing discord.js.
 *
 * `ws.ping` is NaN when no shard exists and -1 until the first heartbeat is
 * acknowledged. Measured against a live connection, it stayed -1 for roughly
 * thirty seconds after login before jumping to a real value — that is the
 * heartbeat interval, not a bug. Mapping both to null is why a command never
 * renders "NaN ms" or "-1 ms", and it is why the acknowledgement round trip
 * rather than this is the figure a ping command should lead with: under
 * `tsx watch` the bot restarts on every save and lives inside that window.
 *
 * `performance.now()` rather than `Date.now()` throughout: monotonic, so a
 * clock correction landing mid-command cannot make the bot report that it
 * answered before it was asked.
 */
function buildLatency(interaction: BaseInteraction): Latency {
  const heartbeat = interaction.client.ws.ping;
  const startedAt = performance.now();

  return {
    gatewayMs: Number.isFinite(heartbeat) && heartbeat >= 0 ? Math.round(heartbeat) : null,
    elapsedMs: () => Math.round(performance.now() - startedAt),
  };
}

/**
 * The interactions this bot replies to.
 *
 * A concrete union rather than discord.js's `RepliableInteraction`, which is
 * itself a union of leaf types that `MessageComponentInteraction` (the base of
 * button and select interactions) is not assignable to.
 */
export type AnyRepliableInteraction =
  ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;

/**
 * How the pipeline answers, whichever way the command arrived.
 *
 * Slash commands acknowledge an interaction; message commands reply to a
 * message. Behind this interface the pipeline cannot tell which, so the guards,
 * the deferral policy, the error mapping and the metrics are one code path
 * rather than two that drift.
 */
export interface Responder {
  readonly hasAcknowledged: boolean;
  defer(visibility?: Visibility): Promise<void>;
  respond(response: Response): Promise<void>;
  followUp(response: Response): Promise<void>;
}

/**
 * Whether an interaction answers by rewriting the message it came from.
 *
 * True for a button or picker, and for a modal opened from one. Those arrive
 * *from* a message the bot already owns, so the answer belongs in that message:
 * a panel whose button posts a second panel is the bug where a settings screen
 * becomes a stack of stale copies, every one of them with live controls.
 *
 * A modal opened by a slash command has no such message and replies normally,
 * which `isFromMessage` is exactly the test for.
 */
function editsSourceMessage(
  interaction: AnyRepliableInteraction,
): interaction is MessageComponentInteraction | ModalMessageModalSubmitInteraction {
  return (
    interaction.isMessageComponent() || (interaction.isModalSubmit() && interaction.isFromMessage())
  );
}

/**
 * Shared reply plumbing.
 *
 * Tracks whether the interaction has been acknowledged, so a handler that
 * defers and one that does not both reach the same `respond` call. Without
 * this, every handler would need to know which reply method applies, which is
 * exactly the discord.js detail the context exists to hide.
 */
export class InteractionResponder implements Responder {
  private acknowledged = false;

  /**
   * Settles when any in-flight acknowledgement finishes.
   *
   * Load-bearing for adaptive deferral: the defer timer and a finishing handler
   * race, and without this both could send a first reply — Discord accepts one
   * and errors on the other. The flag is set synchronously, before the await,
   * so the race is decided the moment either side starts.
   */
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly interaction: AnyRepliableInteraction,
    private readonly renderOptions: RenderOptions,
  ) {}

  get hasAcknowledged(): boolean {
    return this.acknowledged;
  }

  async defer(visibility: Visibility = "ephemeral"): Promise<void> {
    if (this.acknowledged) return this.pending;

    this.acknowledged = true;
    // deferUpdate rather than deferReply when the answer rewrites an existing
    // message: it buys the same time without showing the user a second
    // "thinking…" placeholder underneath the panel they are already looking at.
    this.pending = this.acknowledge(visibility);

    return this.pending;
  }

  private async acknowledge(visibility: Visibility): Promise<void> {
    const { interaction } = this;

    if (editsSourceMessage(interaction)) {
      await interaction.deferUpdate();
      return;
    }

    await interaction.deferReply({ flags: visibility === "ephemeral" ? ["Ephemeral"] : [] });
  }

  /** Sends the main response, choosing reply or edit based on what already happened. */
  async respond(response: Response): Promise<void> {
    // Let a defer that started microseconds ago finish, so the branch below
    // sees the true state rather than the one it started with.
    await this.pending;

    if (response.kind === "form") {
      if (this.acknowledged) {
        // Discord only accepts a modal as the first reply. Saying so beats the
        // silent no-op that would otherwise reach the user.
        throw new TypeError(
          'Cannot open a modal after acknowledging the interaction. Declare the command as defer: "never".',
        );
      }
      if (!("showModal" in this.interaction)) {
        // A modal submission cannot itself open another modal.
        throw new TypeError("This interaction cannot open a modal.");
      }
      await this.interaction.showModal(renderForm(response.form));
      this.acknowledged = true;
      return;
    }

    if (response.kind === "none") {
      if (!this.acknowledged) await this.acknowledge("ephemeral");
      this.acknowledged = true;
      return;
    }

    const rendered = renderResponse(response, this.renderOptions);
    const payload = toPayload(rendered);
    const inPlace = editsSourceMessage(this.interaction);

    // A failure must not destroy the panel it came from. Rewriting the message
    // with an error embed would take the controls away, leaving the user with
    // no way to correct what they did — so an in-place failure arrives beside
    // the panel and the panel stays live.
    if (inPlace && response.kind === "error") {
      if (this.acknowledged) await this.followUp(response);
      else await this.interaction.reply({ ...payload, flags: ["Ephemeral"] });
      this.acknowledged = true;
      return;
    }

    if (this.acknowledged) {
      // After deferUpdate, editReply edits the source message — which is what
      // makes a panel re-render in place rather than pile up copies.
      await this.interaction.editReply(payload);
      return;
    }

    if (inPlace) {
      await this.interaction.update(payload);
      this.acknowledged = true;
      return;
    }

    await this.interaction.reply({
      ...payload,
      flags: rendered.ephemeral ? ["Ephemeral"] : [],
    });
    this.acknowledged = true;
  }

  async followUp(response: Response): Promise<void> {
    if (response.kind === "form" || response.kind === "none") return;

    const rendered = renderResponse(response, this.renderOptions);
    await this.interaction.followUp({
      ...toPayload(rendered),
      flags: rendered.ephemeral ? ["Ephemeral"] : [],
    });
  }
}

export function buildCommandContext(
  interaction: ChatInputCommandInteraction,
  correlationId: string,
  responder: InteractionResponder,
): CommandContext {
  return {
    correlationId,
    actor: buildActor(interaction),
    guild: buildGuild(interaction),
    channel: buildChannel(interaction),
    locale: interaction.locale,
    latency: buildLatency(interaction),
    defer: (visibility) => responder.defer(visibility),
    followUp: (response) => responder.followUp(response),
  };
}

export function buildComponentContext(
  interaction: MessageComponentInteraction,
  correlationId: string,
  payload: string,
  responder: InteractionResponder,
): ComponentContext {
  return {
    correlationId,
    actor: buildActor(interaction),
    guild: buildGuild(interaction),
    channel: buildChannel(interaction),
    locale: interaction.locale,
    latency: buildLatency(interaction),
    payload,
    messageId: asSnowflake(interaction.message.id),
    originalUserId: originalAuthorOf(interaction),
    defer: (visibility) => responder.defer(visibility),
    followUp: (response) => responder.followUp(response),
  };
}

export function buildModalContext(
  interaction: ModalSubmitInteraction,
  correlationId: string,
  payload: string,
  responder: InteractionResponder,
): ModalContext {
  const values: Record<string, string> = {};
  const selected: Record<string, readonly Snowflake[]> = {};

  // Modal components are a union: a text input carries one string, a picker
  // carries a list of ids. Splitting them here is what lets a handler read
  // `values.reason` and `selected.channel` without narrowing anything.
  for (const field of interaction.fields.fields.values()) {
    if ("value" in field && typeof field.value === "string") {
      values[field.customId] = field.value;
    } else if ("values" in field && Array.isArray(field.values)) {
      selected[field.customId] = (field.values as string[]).map(asSnowflake);
    }
  }

  return {
    correlationId,
    actor: buildActor(interaction),
    guild: buildGuild(interaction),
    channel: buildChannel(interaction),
    locale: interaction.locale,
    latency: buildLatency(interaction),
    payload,
    values,
    selected,
    defer: (visibility) => responder.defer(visibility),
    followUp: (response) => responder.followUp(response),
  };
}

/**
 * Who the message belongs to, for the owner-only component check.
 *
 * `interactionMetadata` is present when the message was an interaction reply,
 * which is the case for every message this bot builds controls on.
 */
function originalAuthorOf(interaction: MessageComponentInteraction): Snowflake | undefined {
  const originalUserId = interaction.message.interactionMetadata?.user.id;
  return originalUserId === undefined ? undefined : asSnowflake(originalUserId);
}
