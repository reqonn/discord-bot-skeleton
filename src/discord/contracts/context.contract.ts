import type { Snowflake } from "../../shared/types/snowflake.types.js";

import type { Actor, ChannelRef, GuildRef } from "./actor.contract.js";
import type { Response, Visibility } from "./response.contract.js";

/**
 * Everything a handler knows about the interaction it is serving.
 *
 * This interface is the discord.js containment boundary. Feature code depends
 * on it and never on the library, which means:
 *
 *   - handlers are unit-testable against a hand-written fake, with no mocking
 *   - upgrading or replacing discord.js touches one directory
 *   - the surface stays small, because widening it is a deliberate edit here
 *     rather than an incidental `interaction.guild.members.cache` somewhere
 *
 * The cost is that anything a feature needs from Discord must be modelled.
 * That cost is the point: it forces the question "does a use case really need
 * the whole Guild object?", and the answer is essentially always no.
 */
export interface InteractionContext {
  readonly correlationId: string;
  readonly actor: Actor;
  /** Null in a direct message. Guild-only commands declare `inGuild()`. */
  readonly guild: GuildRef | null;
  readonly channel: ChannelRef;
  /** BCP-47 tag from the user's Discord client, e.g. "en-GB". */
  readonly locale: string;
  /** How the connection to Discord is performing. See {@link Latency}. */
  readonly latency: Latency;

  /**
   * Acknowledges now and replies later.
   *
   * Rarely needed: `defer: "auto"` handles this automatically when a handler
   * runs long. Call it explicitly only when the handler knows up front that it
   * will be slow.
   */
  defer(visibility?: Visibility): Promise<void>;

  /** Sends an additional message after the main response. */
  followUp(response: Response): Promise<void>;
}

/**
 * The latencies a Discord bot can honestly report.
 *
 * Deliberately *not* the usual `Date.now() - interaction.createdTimestamp`.
 * That subtracts a Discord server clock from the local one, so it reports
 * whatever the difference between those two clocks happens to be — routinely
 * negative on a desktop whose clock has drifted a few milliseconds, which is
 * why so many bots show "-25 ms" and nobody can explain it. Neither figure
 * below crosses clocks, so neither can go negative.
 *
 * Modelled here rather than fetched from a client because feature code cannot
 * import discord.js. This is the contract boundary doing its job — a `/ping`
 * that reports real numbers still never touches the library.
 */
export interface Latency {
  /**
   * Gateway heartbeat round-trip in milliseconds.
   *
   * Discord's own measurement of the persistent WebSocket link. Null until the
   * first heartbeat is acknowledged — which measurably takes about 30 seconds
   * after connecting, because that is the heartbeat interval. That window is
   * why this is the *secondary* figure: under `tsx watch`, where the bot
   * restarts on every save, it is unavailable more often than not.
   */
  readonly gatewayMs: number | null;

  /**
   * Milliseconds the bot has spent on this interaction so far.
   *
   * A monotonic local measurement, so it is immune to clock drift and to the
   * system clock being adjusted mid-command. A function rather than a value
   * because it is sampled when read: called as a reply is built, it covers
   * everything the handler did to produce it.
   */
  elapsedMs(): number;
}

export type CommandContext = InteractionContext;

/**
 * A button press.
 *
 * There is no `update` method here on purpose. A component's response replaces
 * the message it is attached to — the pipeline does that for every component,
 * so a panel re-renders in place without any handler asking it to. A handler
 * that could choose otherwise is a panel that behaves differently from the rest
 * of the bot.
 */
export interface ComponentContext extends InteractionContext {
  /** The payload segment of the custom id, already parsed and validated. */
  readonly payload: string;
  /** The message carrying the component that was used. */
  readonly messageId: Snowflake;
  /** The user who owns the message, when it was an interaction reply. */
  readonly originalUserId: Snowflake | undefined;
}

export interface ModalContext extends InteractionContext {
  readonly payload: string;
  /** Text answers, keyed by the field name declared in the FormSpec. */
  readonly values: Readonly<Record<string, string>>;

  /**
   * Picker answers, keyed the same way. Empty for a field nobody chose from.
   *
   * Ids — channel, role or user — resolved by Discord itself, which is why a
   * picker costs the bot no API call and never shows a stale name.
   */
  readonly selected: Readonly<Record<string, readonly Snowflake[]>>;
}

/** Autocomplete runs on a tight budget and may only answer with choices. */
export interface AutocompleteContext {
  readonly correlationId: string;
  readonly actor: Actor;
  readonly guild: GuildRef | null;
  /** The option being completed and what the user has typed so far. */
  readonly focused: { readonly name: string; readonly value: string };
}

export interface AutocompleteChoice {
  readonly name: string;
  readonly value: string | number;
}
