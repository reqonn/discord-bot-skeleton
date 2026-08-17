import type { Result } from "../../shared/result/result.js";
import type { Snowflake } from "../../shared/types/snowflake.types.js";

import type { Response } from "./response.contract.js";

/**
 * Sending a message the bot was not asked for.
 *
 * Everything else a feature can say is a *reply* — the pipeline holds an
 * interaction and answers it. This is the other half: greeting a new member,
 * posting a panel into a channel, writing to a log. Nothing in a feature can do
 * that without this, because sending needs discord.js and discord.js is
 * import-banned outside `src/discord/` (RULE 1).
 *
 * Features take this as a dependency, exactly like a repository:
 *
 * ```ts
 * export interface WelcomeDeps {
 *   readonly messenger: Messenger;
 * }
 * ```
 *
 * Two things the implementation guarantees, and the reason this is a port
 * rather than a loose `client.channels.send` call:
 *
 *   - **It is governed.** Every send goes through the outbound limiter, so one
 *     guild cannot exhaust the bot's rate budget for everyone else, and a
 *     channel that keeps failing trips a circuit rather than being retried
 *     forever.
 *   - **It cannot be mistaken for success.** Sending is genuinely unreliable —
 *     the channel may be gone, the bot may lack permission, Discord may be
 *     down. The `Result` makes the caller decide, rather than an ignored
 *     promise deciding for them.
 *
 * A `Response` goes in, not an embed. The design system renders it, so a
 * message the bot volunteers looks exactly like one it was asked for.
 */
export interface Messenger {
  /**
   * Posts into a channel.
   *
   * @returns the new message's id, so a caller that will edit later can store
   *   it. `Result` is an error when the channel is gone, unwritable, or Discord
   *   refused.
   */
  send(channelId: Snowflake, response: Response, options?: SendOptions): Promise<Result<Snowflake>>;

  /**
   * Replaces a message this bot sent.
   *
   * The pairing that makes a persistent panel work: send once, keep the id,
   * edit in place for every later change rather than posting a new one.
   */
  edit(
    channelId: Snowflake,
    messageId: Snowflake,
    response: Response,
    options?: SendOptions,
  ): Promise<Result<null>>;
}

export interface SendOptions {
  /**
   * Which guild this belongs to, for the per-guild rate budget and circuit.
   *
   * Omitting it puts the send in the shared lane, which is correct for a DM and
   * wrong for anything guild-scoped — one busy server would then spend
   * everyone's budget.
   */
  readonly guildId?: Snowflake | undefined;

  /**
   * Whether this may be delayed or dropped under load.
   *
   * The default is deliberately not "highest". A welcome message is worth
   * sending and not worth starving a user-facing reply for; something a person
   * is actively waiting on should say so.
   */
  readonly priority?: "background" | "normal" | "urgent" | undefined;
}
