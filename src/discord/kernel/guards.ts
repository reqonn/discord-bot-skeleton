import { getRequestContext } from "../../platform/context/request-context.js";
import type { CooldownStore } from "../../platform/ratelimit/cooldown.contract.js";
import {
  AuthorizationError,
  RateLimitError,
  ValidationError,
} from "../../shared/errors/app-error.js";
import type { AuthorizationPolicy } from "../contracts/authorization.contract.js";
import type { CooldownSpec } from "../contracts/command.contract.js";
import type { InteractionContext } from "../contracts/context.contract.js";

/**
 * The checks every interaction passes before its handler runs.
 *
 * Separated from the pipeline because they are the part most likely to grow —
 * a maintenance gate, a blacklist, a per-guild feature flag all belong here —
 * and because each is a pure function that is far easier to test on its own
 * than through a dispatcher.
 *
 * All three throw rather than returning a result. The pipeline has exactly one
 * failure path, and a guard failure is not different in kind from any other.
 */

/**
 * Enforces a declared cooldown.
 *
 * The key includes the operation, so a user's `/ping` budget is not spent by
 * their `/ticket open` budget. Scope decides what the limit is counted
 * against: `user` for personal spam, `guild` for shared expense, `channel` for
 * noise, `global` for anything that hits a third party.
 */
export async function enforceCooldown(
  cooldowns: CooldownStore,
  cooldown: CooldownSpec | undefined,
  context: InteractionContext,
): Promise<void> {
  if (cooldown === undefined) return;

  const scopeId = {
    user: context.actor.userId,
    guild: context.guild?.id ?? context.actor.userId,
    channel: context.channel.id,
    global: "global",
  }[cooldown.scope];

  const operation = getRequestContext()?.operation ?? "unknown";
  const verdict = await cooldowns.hit(
    `${operation}:${cooldown.scope}:${scopeId}`,
    cooldown.limit,
    cooldown.windowMs,
  );

  if (!verdict.allowed) {
    throw new RateLimitError(
      verdict.retryAfterMs,
      `Too fast — try again in ${formatSeconds(verdict.retryAfterMs)}.`,
    );
  }
}

/**
 * Runs every declared policy, rejecting on the first failure.
 *
 * Synchronous, because policies are pure functions over an Actor that was
 * already materialised. An authorization check that awaits is a check on the
 * latency budget.
 */
export function enforceAuthorization(
  policies: readonly AuthorizationPolicy[],
  context: InteractionContext,
): void {
  for (const policy of policies) {
    const outcome = policy.check(context);
    if (!outcome.allowed) {
      throw new AuthorizationError(outcome.reason, { meta: { policy: policy.name } });
    }
  }
}

/**
 * Turns validator issues into one user-facing message.
 *
 * Every issue is reported, not just the first: telling someone their subject is
 * too short, waiting for them to fix it, and then telling them the reason is
 * too long is a poor way to spend two round trips.
 */
export function toValidationError(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): ValidationError {
  const described = issues
    .map((issue) => {
      const field = issue.path.map(String).join(".");
      return field === "" ? issue.message : `${field}: ${issue.message}`;
    })
    .join("\n");

  return new ValidationError(described === "" ? "That input is not valid." : described);
}

function formatSeconds(ms: number): string {
  const seconds = Math.ceil(ms / 1_000);
  return seconds === 1 ? "1 second" : `${String(seconds)} seconds`;
}
