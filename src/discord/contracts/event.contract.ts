import type { Snowflake } from "../../shared/types/snowflake.types.js";

/**
 * Gateway events, translated into plain data.
 *
 * Features subscribe to these rather than to discord.js events, for the same
 * reason they use CommandContext rather than ChatInputCommandInteraction: a
 * handler that receives a `Channel` object ends up reaching through it, and the
 * containment boundary quietly stops holding.
 *
 * Modelling only what is used also keeps the surface honest. Adding an event
 * means adding its payload here and its translation in the kernel — a small,
 * visible edit rather than an incidental new coupling.
 */
export interface EventPayloads {
  /**
   * Someone joined a server.
   *
   * Requires the privileged **Server Members** intent. Subscribing to this is
   * what makes the bot request it — no configuration involved — because an
   * application that has not been granted the intent must not ask for it, or
   * the gateway refuses the login outright.
   */
  readonly memberJoined: {
    readonly guildId: Snowflake;
    readonly guildName: string;
    readonly userId: Snowflake;
    /** The member's own name — their nickname here, or their global one. */
    readonly displayName: string;
    /** Members in the guild after the join — for a "you are member 500" line. */
    readonly memberCount: number;
  };

  readonly channelDeleted: {
    readonly guildId: Snowflake | null;
    readonly channelId: Snowflake;
  };
  readonly guildJoined: {
    readonly guildId: Snowflake;
    readonly name: string;
    readonly memberCount: number;
  };
  readonly guildLeft: {
    readonly guildId: Snowflake;
  };
}

export type EventName = keyof EventPayloads;

export interface EventDescriptor<TName extends EventName = EventName> {
  readonly event: TName;
  /** Identifies the subscriber in logs, and keeps two handlers distinguishable. */
  readonly name: string;

  /**
   * Handles the event.
   *
   * Failures are logged and swallowed by the kernel: one feature's broken
   * subscriber must not stop another's from running, and there is no user
   * waiting on a reply to inform.
   */
  handle(payload: EventPayloads[TName]): Promise<void>;
}

export function defineEvent<TName extends EventName>(
  descriptor: EventDescriptor<TName>,
): EventDescriptor<TName> {
  return descriptor;
}
