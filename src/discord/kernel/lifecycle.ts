import { Events, type Client } from "discord.js";

import {
  createRequestContext,
  runWithRequestContext,
} from "../../platform/context/request-context.js";
import type { Logger } from "../../platform/logging/logger.contract.js";
import { ConfigurationError, InfrastructureError } from "../../shared/errors/app-error.js";
import { asSnowflake } from "../../shared/types/snowflake.types.js";
import type { EventName, EventPayloads } from "../contracts/event.contract.js";

import type { InteractionPipeline } from "./pipeline.js";
import type { InteractionRegistry } from "./registry.js";

/**
 * Logs in and waits for the gateway to actually be ready.
 *
 * `client.login()` resolves when the websocket connects, not when the bot is
 * usable — so a process that awaits only login can report itself healthy while
 * being entirely offline. The deadline turns "connected but never ready" into a
 * boot failure, which an orchestrator restarts, instead of a silent outage
 * nobody is paged for.
 */
export async function loginAndAwaitReady(
  client: Client,
  token: string,
  timeoutMs: number,
): Promise<void> {
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new InfrastructureError(
          `The gateway did not report ready within ${String(timeoutMs)}ms. Refusing to run in a connected-but-offline state.`,
        ),
      );
    }, timeoutMs);

    client.once(Events.ClientReady, () => {
      clearTimeout(timer);
      resolve();
    });
  });

  try {
    await client.login(token);
  } catch (error) {
    throw explainLoginFailure(error);
  }

  await ready;
}

/**
 * Turns a gateway rejection into something actionable.
 *
 * "Used disallowed intents" is the single most likely first-run failure once
 * message commands exist, and on its own it names neither the intent nor the
 * fix — leaving someone to discover that a privileged toggle in a web portal is
 * what stands between them and a working bot.
 */
function explainLoginFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (!message.toLowerCase().includes("disallowed intents")) {
    return error instanceof Error ? error : new InfrastructureError(message);
  }

  return new ConfigurationError(
    [
      "Discord rejected the login: this application is not allowed the intents it asked for.",
      "",
      "Enable the matching toggles at https://discord.com/developers/applications",
      "→ your app → Bot → Privileged Gateway Intents:",
      "",
      "  Message Content   needed for message commands (!ping).",
      "                    Set COMMAND_PREFIX= blank in .env to stop asking.",
      "  Server Members    needed to greet people who join.",
      "                    Remove the memberJoined event from a feature to stop asking.",
      "",
      "Slash commands need neither, and work either way.",
    ].join("\n"),
  );
}

/**
 * Wires gateway traffic into the pipeline and the event subscribers.
 *
 * Gateway events are translated into the plain payloads declared in
 * event.contract.ts before any feature sees them — for the same reason
 * handlers get a CommandContext rather than an interaction. A subscriber that
 * receives a discord.js `Channel` starts reaching through it, and the
 * containment boundary quietly stops holding.
 */
export function attachGateway(
  client: Client,
  pipeline: InteractionPipeline,
  registry: InteractionRegistry,
  logger: Logger,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    // The pipeline renders its own failures; anything escaping it is a bug in
    // the pipeline itself and must not take the process down.
    void pipeline.handle(interaction).catch((error: unknown) => {
      logger.error("Interaction pipeline threw", { error });
    });
  });

  // Every message in every guild the bot can see reaches this, so the cheap
  // rejections — wrong prefix, a bot author — happen before anything else. The
  // pipeline returns immediately when message commands are off.
  client.on(Events.MessageCreate, (message) => {
    void pipeline.handleMessage(message).catch((error: unknown) => {
      logger.error("Message pipeline threw", { error });
    });
  });

  // Fires only when the Server Members intent was requested; discord.js simply
  // never receives the event otherwise, so no guard is needed here.
  client.on(Events.GuildMemberAdd, (member) => {
    void dispatch(registry, logger, "memberJoined", {
      guildId: asSnowflake(member.guild.id),
      guildName: member.guild.name,
      userId: asSnowflake(member.id),
      displayName: member.displayName,
      memberCount: member.guild.memberCount,
    });
  });

  client.on(Events.ChannelDelete, (channel) => {
    void dispatch(registry, logger, "channelDeleted", {
      guildId:
        "guildId" in channel && channel.guildId !== null ? asSnowflake(channel.guildId) : null,
      channelId: asSnowflake(channel.id),
    });
  });

  client.on(Events.GuildCreate, (guild) => {
    void dispatch(registry, logger, "guildJoined", {
      guildId: asSnowflake(guild.id),
      name: guild.name,
      memberCount: guild.memberCount,
    });
  });

  client.on(Events.GuildDelete, (guild) => {
    void dispatch(registry, logger, "guildLeft", { guildId: asSnowflake(guild.id) });
  });

  client.on(Events.Error, (error) => {
    logger.error("Gateway error", { error });
  });

  client.on(Events.Warn, (message) => {
    logger.warn("Gateway warning", { detail: message });
  });
}

/**
 * Runs every subscriber for an event.
 *
 * Failures are logged and contained: one feature's broken subscriber must not
 * stop another's from running, and unlike an interaction there is nobody
 * waiting on a reply to inform.
 */
async function dispatch<TName extends EventName>(
  registry: InteractionRegistry,
  logger: Logger,
  event: TName,
  payload: EventPayloads[TName],
): Promise<void> {
  const subscribers = registry.subscribersFor(event);
  if (subscribers.length === 0) return;

  await Promise.all(
    subscribers.map(async (subscriber) => {
      const context = createRequestContext(
        {
          source: "event",
          operation: `${event}:${subscriber.name}`,
          guildId: "guildId" in payload && payload.guildId !== null ? payload.guildId : undefined,
        },
        Date.now(),
      );

      await runWithRequestContext(context, async () => {
        try {
          await (subscriber as { handle(p: EventPayloads[TName]): Promise<void> }).handle(payload);
        } catch (error) {
          logger.error("Event subscriber failed", { error, event, subscriber: subscriber.name });
        }
      });
    }),
  );
}
