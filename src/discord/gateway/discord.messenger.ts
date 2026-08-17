import type { Client } from "discord.js";

import type { Logger } from "../../platform/logging/logger.contract.js";
import { DiscordError } from "../../shared/errors/app-error.js";
import type { Result } from "../../shared/result/result.js";
import { asSnowflake, type Snowflake } from "../../shared/types/snowflake.types.js";
import type { Messenger, SendOptions } from "../contracts/messenger.contract.js";
import type { Response } from "../contracts/response.contract.js";
import { renderResponse, toPayload } from "../ui/render.js";

import { ActionPriority } from "./action.types.js";
import type { OutboundLimiter } from "./outbound.limiter.js";

/**
 * The messenger port, over discord.js and the outbound limiter.
 *
 * This is the only path by which a feature reaches Discord on its own
 * initiative, which is what makes the governor meaningful: every volunteered
 * message is counted against its guild's budget and its feature's circuit,
 * rather than a scattering of direct `channel.send` calls that no rate limiter
 * can see.
 *
 * Interaction *replies* deliberately do not come through here. They answer a
 * user who is waiting, they use the interaction token rather than the channel,
 * and delaying one to protect a background send would be exactly backwards.
 */

const PRIORITIES = {
  background: ActionPriority.Low,
  normal: ActionPriority.Normal,
  urgent: ActionPriority.High,
} as const;

export class DiscordMessenger implements Messenger {
  constructor(
    /**
     * Resolved on use, not on construction.
     *
     * Features take the messenger as a dependency, and the client cannot exist
     * until the features are built — its intents are derived from what they
     * subscribed to. Nothing sends before login, so a provider breaks that
     * cycle honestly rather than by reordering the boot into something less
     * defensible.
     */
    private readonly clientOf: () => Client | undefined,
    private readonly limiter: OutboundLimiter,
    private readonly logger: Logger,
    /** Errors carry `detail` only outside production; the renderer decides. */
    private readonly showErrorDetail: boolean,
  ) {}

  async send(
    channelId: Snowflake,
    response: Response,
    options: SendOptions = {},
  ): Promise<Result<Snowflake>> {
    return this.through("send", channelId, options, async () => {
      const channel = await this.sendableChannel(channelId);
      const rendered = renderResponse(response, { showErrorDetail: this.showErrorDetail });

      const message = await channel.send({
        ...toPayload(rendered),
      });

      return asSnowflake(message.id);
    });
  }

  async edit(
    channelId: Snowflake,
    messageId: Snowflake,
    response: Response,
    options: SendOptions = {},
  ): Promise<Result<null>> {
    return this.through("edit", channelId, options, async () => {
      const channel = await this.sendableChannel(channelId);
      const rendered = renderResponse(response, { showErrorDetail: this.showErrorDetail });

      const message = await channel.messages.fetch(messageId);
      await message.edit(toPayload(rendered));

      return null;
    });
  }

  /**
   * Runs the call under the governor and turns any throw into a `Result`.
   *
   * Every reason a send fails is ordinary — the channel was deleted, a
   * permission was removed, Discord returned 500 — and none of them should
   * reach a caller as an exception from something it did not await carefully.
   */
  private async through<T>(
    action: string,
    channelId: Snowflake,
    options: SendOptions,
    execute: () => Promise<T>,
  ): Promise<Result<T>> {
    const result = await this.limiter.run<T>({
      guildId: options.guildId ?? null,
      feature: "messenger",
      priority: PRIORITIES[options.priority ?? "normal"],
      execute,
    });

    if (!result.ok) {
      // Logged here because the limiter's refusals (a tripped circuit, a full
      // queue) are operational facts a caller can do nothing about, and would
      // otherwise be invisible.
      this.logger.warn("Could not reach Discord", { action, channelId, error: result.error });
    }

    return result;
  }

  private async sendableChannel(channelId: Snowflake) {
    const client = this.clientOf();
    if (client === undefined) {
      // Only reachable by sending during boot, before the gateway exists —
      // a wiring bug, not a runtime condition.
      throw new TypeError("The messenger was used before the Discord client was created.");
    }

    const channel = await client.channels.fetch(channelId);

    if (channel === null || !channel.isTextBased() || !channel.isSendable()) {
      // A configured channel that has since been deleted or locked down is the
      // single most common cause, and it is a normal state — not a bug.
      throw new DiscordError(`Channel ${channelId} is missing or cannot be written to.`);
    }

    return channel;
  }
}
