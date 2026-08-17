import type { Snowflake } from "../types/snowflake.types.js";

import type { Catalogue } from "./template.js";

/**
 * The placeholders any message about a member in a server can use.
 *
 * Shared because the same set is wanted by every feature that greets, says
 * goodbye, or announces someone: welcome, leave, boost, autoresponders. Writing
 * them per feature is how `{user}` ends up meaning a mention in one place and a
 * username in another.
 *
 * **Everything here is derived, never fetched.** That is the line that keeps
 * this synchronous and therefore usable from `domain/`. A member's roles,
 * avatar, badges or colour would each need an API call or a populated cache;
 * those are resolved in `api/` and passed in as context, not added below.
 *
 * **Names are dotted and grouped** — `{user.id}`, `{server.count}` — with the
 * bare `{user}`, `{server}` and `{channel}` reserved for the one form each is
 * almost always wanted in. There are deliberately no aliases: two spellings of
 * one value is two things to document, two to test, and one that will
 * eventually be forgotten when the other changes.
 */

export interface MemberContext {
  readonly userId: Snowflake;
  /** Their nickname in this server, or their global display name. */
  readonly userName: string;
  readonly serverId: Snowflake;
  readonly serverName: string;
  /** Members after the join, so `{server.count}` reads as a position. */
  readonly memberCount: number;
  /** Where the message is going. Null when nothing has been chosen yet. */
  readonly channelId: Snowflake | null;
}

export const MEMBER_PLACEHOLDERS: Catalogue<MemberContext> = {
  "{user}": (context) => `<@${context.userId}>`,
  "{user.name}": (context) => context.userName,
  "{user.id}": (context) => context.userId,
  /**
   * When the account was made, as a live relative timestamp.
   *
   * Read straight out of the snowflake — Discord ids carry their creation time
   * — so a message can say "account created 2 hours ago" with no API call and
   * no stored data. That is worth having: an account minutes old joining is the
   * single most useful signal a welcome message can carry.
   */
  "{user.created}": (context) => `<t:${String(createdAtSeconds(context.userId))}:R>`,

  "{server}": (context) => context.serverName,
  "{server.id}": (context) => context.serverId,
  "{server.count}": (context) => String(context.memberCount),
  /** The same number as a position — "our 500th member" rather than "500". */
  "{server.ordinal}": (context) => ordinal(context.memberCount),

  /** Where this message was posted, as a mention. */
  "{channel}": (context) => (context.channelId === null ? "" : `<#${context.channelId}>`),
};

/** Discord's epoch. Ids are `(ms since this) << 22` plus worker and sequence bits. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

function createdAtSeconds(id: Snowflake): number {
  // Falls back to the epoch rather than throwing on a malformed id: this runs
  // while rendering a message, and a broken timestamp is a better outcome than
  // a greeting nobody receives.
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS) / 1_000;
  } catch {
    return Number(DISCORD_EPOCH_MS / 1_000n);
  }
}

/**
 * 1 → "1st", 12 → "12th", 22 → "22nd".
 *
 * The teens are the exception every naive version gets wrong, so they are
 * handled first: 11, 12 and 13 take "th" despite ending in 1, 2 and 3.
 */
function ordinal(value: number): string {
  const teens = value % 100;
  if (teens >= 11 && teens <= 13) return `${String(value)}th`;

  const suffix = { 1: "st", 2: "nd", 3: "rd" }[value % 10] ?? "th";
  return `${String(value)}${suffix}`;
}
