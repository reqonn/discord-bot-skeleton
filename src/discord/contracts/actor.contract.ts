import type { Snowflake } from "../../shared/types/snowflake.types.js";

/**
 * The Discord permissions this bot reasons about.
 *
 * A closed set rather than the full permission list, because every entry here
 * is a permission some command actually checks. Adding one is a deliberate act:
 * you add the name, map it in the context factory, and the compiler finds
 * everywhere that needs updating. An open `string` would let a typo become a
 * check that silently never passes.
 */
export type PermissionName =
  | "Administrator"
  | "ManageGuild"
  | "ManageChannels"
  | "ManageMessages"
  | "ManageRoles"
  | "ModerateMembers"
  | "KickMembers"
  | "BanMembers";

/**
 * Who is performing an action.
 *
 * Fully materialised before a handler runs, so an authorization check is a pure
 * function over data rather than an API call. That is what keeps permission
 * checks off the latency budget entirely.
 */
export interface Actor {
  readonly userId: Snowflake;
  /** Server nickname if set, otherwise the global display name. For rendering only. */
  readonly displayName: string;
  readonly isBot: boolean;
  readonly roleIds: readonly Snowflake[];
  /** Effective permissions in the channel the interaction came from. */
  readonly permissions: ReadonlySet<PermissionName>;
  readonly isGuildOwner: boolean;
}

export interface GuildRef {
  readonly id: Snowflake;
  readonly name: string;
}

export interface ChannelRef {
  readonly id: Snowflake;
  readonly name: string;
  /** Category the channel sits in, if any. */
  readonly parentId: Snowflake | null;
}

export function hasPermission(actor: Actor, permission: PermissionName): boolean {
  // Administrator implies everything. Checking it here means no policy has to
  // remember to, and none of them can forget.
  return actor.permissions.has("Administrator") || actor.permissions.has(permission);
}
