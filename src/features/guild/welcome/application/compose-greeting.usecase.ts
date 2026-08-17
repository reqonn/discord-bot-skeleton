import { say } from "#shared/errors/phrasing.js";
import { err, ok, type Result } from "#shared/result/result.js";
import type { Snowflake } from "#shared/types/snowflake.types.js";

import { WelcomeNotReadyError } from "../domain/welcome.errors.js";
import { renderWelcome } from "../domain/welcome.rules.js";

import type { ConfigureWelcomeUseCase } from "./configure-welcome.usecase.js";

export interface JoinedMember {
  readonly guildId: Snowflake;
  readonly serverName: string;
  readonly userId: Snowflake;
  readonly userName: string;
  readonly memberCount: number;
}

/** What to post, and where. The adapter does the posting. */
export interface Greeting {
  readonly channelId: Snowflake;
  readonly text: string;
}

/**
 * Works out how a new member should be greeted.
 *
 * Note what it does *not* do: send anything. The application layer decides
 * **what** should be said and **where** it goes; the adapter in `api/` performs
 * the I/O, because that is the layer allowed to know Discord exists. The
 * architecture check enforces the split — an earlier version of this file
 * reached for the messenger directly and was rejected.
 *
 * The payoff is a test with no fakes at all: settings in, text out, and the
 * placeholder substitution asserted directly.
 *
 * `/welcome test` and the member-join event both call this, so a preview cannot
 * disagree with the real thing about the message or the destination.
 */
export class ComposeGreetingUseCase {
  // Reads through the configure use case rather than the repository, so the
  // join path gets its cache. This runs on every join in every guild; going
  // straight to storage would make the most common event the most expensive.
  constructor(private readonly configure: ConfigureWelcomeUseCase) {}

  async execute(member: JoinedMember): Promise<Result<Greeting>> {
    const current = await this.configure.settings(member.guildId);
    if (!current.ok) return current;

    const settings = current.value;

    // Not configured, or switched off. The join event fires for every guild the
    // bot is in, and most will never have set one up — so this is the ordinary
    // answer, not an error worth logging.
    if (!settings.enabled || settings.channelId === null) {
      return err(new WelcomeNotReadyError(say.noneConfigured("welcome message")));
    }

    return ok({
      channelId: settings.channelId,
      text: renderWelcome(settings.message, {
        userId: member.userId,
        userName: member.userName,
        serverId: member.guildId,
        serverName: member.serverName,
        memberCount: member.memberCount,
        // Where the greeting lands, so "{channel}" reads as the channel the
        // member is looking at rather than a second thing to configure.
        channelId: settings.channelId,
      }),
    });
  }
}
