import { z } from "zod";

import {
  inGuild,
  requireGuild,
  requirePermission,
} from "#discord/contracts/authorization.contract.js";
import { defineCommand } from "#discord/contracts/command.contract.js";
import type { Messenger } from "#discord/contracts/messenger.contract.js";
import type { Response } from "#discord/contracts/response.contract.js";

import { asSnowflake } from "#shared/types/snowflake.types.js";

import type { ComposeGreetingUseCase } from "../application/compose-greeting.usecase.js";
import type { ConfigureWelcomeUseCase } from "../application/configure-welcome.usecase.js";

import { editor, greeting, reset, saved, sent } from "./welcome.presenter.js";

/**
 * `/welcome` — configure the greeting new members get.
 *
 * Direct subcommands, because that is what a two-field setting deserves:
 *
 *   /welcome                 show what is configured
 *   /welcome message <text>  set the message
 *   /welcome channel <#c>    set where it goes
 *   /welcome test            post it now, to see it for real
 *   /welcome reset           stop greeting people
 *   /welcome edit            open a panel instead, if you would rather
 *
 * `!welcome message Hi {user}` works too, from these same descriptors.
 *
 * Every handler is the same three lines — authorize, call a use case, present —
 * and none contains a rule, a query, or a sentence. Those live in `domain/`,
 * `infrastructure/` and `welcome.presenter.ts` respectively.
 */

const MANAGERS = [inGuild(), requirePermission("ManageGuild")] as const;

export function createWelcomeCommands(
  configure: ConfigureWelcomeUseCase,
  compose: ComposeGreetingUseCase,
  messenger: Messenger,
) {
  const view = defineCommand({
    name: "welcome",
    description: "Show the greeting new members receive",
    input: z.object({}),
    authorize: [...MANAGERS],
    handle: async (context): Promise<Response> => {
      const guild = requireGuild(context, "/welcome");
      const settings = await configure.settings(guild.id);

      return settings.ok
        ? editor(settings.value, guild.name)
        : { kind: "error", error: settings.error };
    },
  });

  const message = defineCommand({
    name: "welcome message",
    description: "Set the message new members are greeted with",
    options: [
      {
        type: "string",
        name: "message",
        description: "Text shown when someone joins. Supports {user} and {server}",
        required: true,
      },
    ],
    input: z.object({ message: z.string().min(1).max(2_000) }),
    authorize: [...MANAGERS],
    handle: async (context, input): Promise<Response> => {
      const guild = requireGuild(context, "/welcome");
      const result = await configure.setMessage(guild.id, input.message);

      return result.ok ? saved(result.value) : { kind: "error", error: result.error };
    },
  });

  const channel = defineCommand({
    name: "welcome channel",
    description: "Set where the greeting is posted",
    options: [
      {
        type: "channel",
        name: "channel",
        description: "The channel new members are greeted in",
        required: true,
      },
    ],
    input: z.object({ channel: z.string() }),
    authorize: [...MANAGERS],
    handle: async (context, input): Promise<Response> => {
      const guild = requireGuild(context, "/welcome");
      const result = await configure.setChannel(guild.id, asSnowflake(input.channel));

      return result.ok ? saved(result.value) : { kind: "error", error: result.error };
    },
  });

  const test = defineCommand({
    name: "welcome test",
    description: "Post the greeting as if you had just joined",
    input: z.object({}),
    authorize: [...MANAGERS],
    // The only cooldown in the repository. Every other command here writes a
    // row or reads one; this one posts a real message into a real channel, so
    // the cost of repeating it lands on people who did not run it.
    cooldown: { scope: "user", limit: 3, windowMs: 60_000 },
    handle: async (context): Promise<Response> => {
      const guild = requireGuild(context, "/welcome");

      // Runs the real greeting path rather than a preview of it, so what you
      // see is what a new member gets — including a channel that has since been
      // deleted, which a preview would happily pretend was fine.
      const greet = await compose.execute({
        guildId: guild.id,
        serverName: guild.name,
        userId: context.actor.userId,
        userName: context.actor.displayName,
        memberCount: 1,
      });
      if (!greet.ok) return { kind: "error", error: greet.error };

      const posted = await messenger.send(greet.value.channelId, greeting(greet.value.text), {
        guildId: guild.id,
      });

      return posted.ok ? sent(greet.value.channelId) : { kind: "error", error: posted.error };
    },
  });

  const clear = defineCommand({
    name: "welcome reset",
    description: "Remove the greeting and stop welcoming new members",
    input: z.object({}),
    authorize: [...MANAGERS],
    handle: async (context): Promise<Response> => {
      const guild = requireGuild(context, "/welcome");
      const result = await configure.reset(guild.id);

      return result.ok ? reset() : { kind: "error", error: result.error };
    },
  });

  const open = defineCommand({
    name: "welcome edit",
    description: "Open a panel to change the message and channel",
    input: z.object({}),
    authorize: [...MANAGERS],
    handle: async (context): Promise<Response> => {
      const guild = requireGuild(context, "/welcome");
      const settings = await configure.settings(guild.id);

      return settings.ok
        ? editor(settings.value, guild.name)
        : { kind: "error", error: settings.error };
    },
  });

  return [view, message, channel, test, clear, open];
}
