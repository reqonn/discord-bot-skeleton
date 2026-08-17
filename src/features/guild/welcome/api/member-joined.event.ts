import type { Logger } from "#platform/logging/logger.contract.js";

import { defineEvent } from "#discord/contracts/event.contract.js";
import type { Messenger } from "#discord/contracts/messenger.contract.js";

import type { ComposeGreetingUseCase } from "../application/compose-greeting.usecase.js";

import { greeting } from "./welcome.presenter.js";

/**
 * Greets each new member.
 *
 * An event adapter is a trigger, like a command: translate the payload, ask a
 * use case what to say, and post it. The use case is the same one `/welcome
 * test` calls, so the two cannot disagree about the message or the channel.
 *
 * Failures are swallowed on purpose. Nobody is waiting on a reply — there is no
 * interaction to answer — and by far the most common one is "this guild never
 * configured a welcome message", which fires for every join in every server.
 *
 * Registering this is what makes the bot request the privileged Server Members
 * intent — the boot derives its intents from what features subscribed to, so
 * there is no configuration to keep in step. Delete this file and the bot stops
 * asking for it.
 */
export function createMemberJoinedEvent(
  compose: ComposeGreetingUseCase,
  messenger: Messenger,
  logger: Logger,
) {
  return defineEvent({
    event: "memberJoined",
    name: "welcome.greet",
    handle: async (payload) => {
      const greet = await compose.execute({
        guildId: payload.guildId,
        serverName: payload.guildName,
        userId: payload.userId,
        userName: payload.displayName,
        memberCount: payload.memberCount,
      });

      // Not configured is the normal state of most guilds, and would otherwise
      // be the noisiest line in the log.
      if (!greet.ok) return;

      const posted = await messenger.send(greet.value.channelId, greeting(greet.value.text), {
        guildId: payload.guildId,
        // Worth sending, not worth delaying a reply someone is waiting on.
        priority: "background",
      });

      // A deleted channel or a removed permission is how this quietly stops
      // working, and silence is the hardest failure to notice.
      if (!posted.ok) {
        logger.warn("Could not greet a new member", {
          error: posted.error,
          guildId: payload.guildId,
        });
      }
    },
  });
}
