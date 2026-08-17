import { Client, GatewayIntentBits, Options, Partials } from "discord.js";

/**
 * Builds the gateway client.
 *
 * Two settings here matter more than everything else in this directory
 * combined, and both are easy to get wrong by omission:
 *
 * **Intents.** `Guilds` always; message intents only when message commands are
 * turned on. Every additional intent is a stream of events the process must
 * parse and dispatch whether or not anything cares — and `MessageContent` is
 * privileged, so requesting it when the application has not been granted it
 * makes the gateway reject the login outright. That is why the prefix being
 * unset has to mean "do not ask", rather than "ask and ignore what arrives".
 *
 * **Cache limits.** discord.js caches without bound by default. A bot left
 * running for weeks accumulates every user it has seen, and the default
 * sweepers only remove bots — so human users leak for the process lifetime.
 * Capping the managers and running real sweepers is the difference between
 * steady memory and a slow climb to a restart.
 */
export interface ClientOptions {
  /** Whether to request the intents message commands need. */
  readonly messageCommands: boolean;
  /** Whether to request the intent member-join events need. */
  readonly memberEvents: boolean;
}

export function createClient(options: ClientOptions): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      ...(options.messageCommands
        ? [
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
            // Privileged. Must be enabled for the application in the Discord
            // developer portal, or login fails — see lifecycle.ts, which turns
            // that rejection into a message saying so.
            GatewayIntentBits.MessageContent,
          ]
        : []),
      // Also privileged, and requested only when something subscribes to member
      // joins. Both toggles follow the same rule: never ask for an intent the
      // application may not have been granted.
      ...(options.memberEvents ? [GatewayIntentBits.GuildMembers] : []),
    ],

    // Needed so events still fire for entities that were never cached, which is
    // the normal case once the caches below are capped.
    partials: [Partials.Channel],

    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,

      // Nothing reads message history. A message command is handled from the
      // event payload, which is complete, so caching buys nothing.
      MessageManager: 0,
      // Presence is by far the largest and least useful cache for a bot with
      // no presence features.
      PresenceManager: 0,
      ReactionManager: 0,
      GuildInviteManager: 0,
      GuildScheduledEventManager: 0,

      // Members and users are looked up by id when needed. Keep our own entry,
      // which is consulted on nearly every permission calculation.
      GuildMemberManager: {
        maxSize: 100,
        keepOverLimit: (member) => member.id === member.client.user.id,
      },
      UserManager: {
        maxSize: 500,
        keepOverLimit: (user) => user.id === user.client.user.id,
      },
    }),

    sweepers: {
      ...Options.DefaultSweeperSettings,
      messages: { interval: 300, lifetime: 900 },
      // The default sweeper only removes bots, so humans accumulate forever.
      users: {
        interval: 3_600,
        filter: () => (user) => user.id !== user.client.user.id,
      },
      guildMembers: {
        interval: 3_600,
        filter: () => (member) => member.id !== member.client.user.id,
      },
    },

    rest: {
      // Below the 3s interaction budget: a hung REST call should fail in time
      // for the pipeline to still say something useful.
      timeout: 15_000,
      retries: 2,
    },

    allowedMentions: {
      // Nothing this bot sends should ping a role or @everyone unless a feature
      // asks for it explicitly. Defaulting the other way is how a status embed
      // notifies a whole server.
      parse: ["users"],
      repliedUser: false,
    },
  });
}
