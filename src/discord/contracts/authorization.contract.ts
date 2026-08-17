import { hasPermission, type GuildRef, type PermissionName } from "./actor.contract.js";
import type { InteractionContext } from "./context.contract.js";

export type AuthorizationOutcome =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * One authorization rule.
 *
 * Policies are pure functions over the already-materialised Actor, so a check
 * costs no API call and no database read. They are declared on the command
 * rather than written inside it, which means "who may run this?" is answerable
 * by reading the descriptor — and means the pipeline can guarantee that a
 * command with no declared policy fails to compile rather than silently
 * allowing everyone.
 */
export interface AuthorizationPolicy {
  readonly name: string;
  check(context: InteractionContext): AuthorizationOutcome;
}

const ALLOWED: AuthorizationOutcome = { allowed: true };

function deny(reason: string): AuthorizationOutcome {
  return { allowed: false, reason };
}

/** Rejects direct messages. Anything touching guild state needs this. */
export function inGuild(): AuthorizationPolicy {
  return {
    name: "inGuild",
    check: (context) =>
      context.guild === null ? deny("This command only works in a server.") : ALLOWED,
  };
}

/**
 * Narrows the guild that `inGuild()` has already guaranteed.
 *
 * Lives beside the policy it depends on, so the pair is impossible to miss and
 * there is one copy rather than one per feature. Every guild-only handler needs
 * this — `context.guild` is `GuildRef | null` for the DM case, and a handler
 * that declared `inGuild()` still has to convince the compiler of what the
 * pipeline already enforced.
 *
 * It throws rather than returning an error `Response`, and the distinction is
 * RULE 5: reaching here means the descriptor lost its `inGuild()`, which is a
 * bug in that file, not a failure a user can cause.
 */
export function requireGuild(context: InteractionContext, command: string): GuildRef {
  if (context.guild === null) {
    throw new TypeError(`${command} ran outside a guild despite declaring inGuild().`);
  }
  return context.guild;
}

export function requirePermission(permission: PermissionName): AuthorizationPolicy {
  return {
    name: `requirePermission(${permission})`,
    check: (context) =>
      hasPermission(context.actor, permission)
        ? ALLOWED
        : deny(`You need the ${humanise(permission)} permission to do that.`),
  };
}

export function requireGuildOwner(): AuthorizationPolicy {
  return {
    name: "requireGuildOwner",
    check: (context) =>
      context.actor.isGuildOwner ? ALLOWED : deny("Only the server owner can do that."),
  };
}

/**
 * Passes if any policy passes.
 *
 * Reports the *last* failure rather than concatenating all of them: telling a
 * user "you need Manage Channels or to be the ticket owner or to be the server
 * owner" is worse than telling them the one thing most likely to apply.
 */
export function anyOf(...policies: readonly AuthorizationPolicy[]): AuthorizationPolicy {
  return {
    name: `anyOf(${policies.map((policy) => policy.name).join(", ")})`,
    check: (context) => {
      let lastFailure: AuthorizationOutcome = deny("You cannot do that.");

      for (const policy of policies) {
        const outcome = policy.check(context);
        if (outcome.allowed) return ALLOWED;
        lastFailure = outcome;
      }

      return lastFailure;
    },
  };
}

/**
 * Anyone may run this.
 *
 * Exists so that "open to everyone" is written down. A command with an empty
 * policy list is indistinguishable from one where the author forgot, and the
 * review question "did you mean to leave this open?" has no answer.
 */
export function openToEveryone(): AuthorizationPolicy {
  return { name: "openToEveryone", check: () => ALLOWED };
}

function humanise(permission: PermissionName): string {
  return permission.replace(/([a-z])([A-Z])/g, "$1 $2");
}
