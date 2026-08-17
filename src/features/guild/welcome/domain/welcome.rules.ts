import { say } from "#shared/errors/phrasing.js";
import { err, ok, type Result } from "#shared/result/result.js";
import { MEMBER_PLACEHOLDERS, type MemberContext } from "#shared/text/placeholders.js";
import { namesOf, render, unknownIn } from "#shared/text/template.js";
import type { Snowflake } from "#shared/types/snowflake.types.js";

import { InvalidWelcomeMessageError } from "./welcome.errors.js";

/**
 * What a guild has configured, and the rules that protect it.
 *
 * Domain code is pure: values in, decisions out. No database, no clock, no
 * Discord. This is the layer that answers "is this allowed?", and it answers
 * the same way no matter who asks — the command, the button, or the modal.
 */

export interface WelcomeSettings {
  readonly guildId: Snowflake;
  readonly channelId: Snowflake | null;
  readonly message: string;
  readonly enabled: boolean;
}

export const MAX_MESSAGE_LENGTH = 1_000;

/** What every message about this calls it, so they all agree. */
const LABEL = "A welcome message";

/**
 * The placeholders a welcome message may use.
 *
 * Taken whole from `#shared/text/placeholders` rather than declared here: the
 * same set belongs to every feature that writes about a member joining or
 * leaving, and one catalogue is what stops `{user}` meaning a mention in one
 * and a username in another.
 */
export const PLACEHOLDERS = MEMBER_PLACEHOLDERS;
export const PLACEHOLDER_NAMES = namesOf(PLACEHOLDERS);

export type WelcomeContext = MemberContext;

export function parseWelcomeMessage(raw: string): Result<string, InvalidWelcomeMessageError> {
  const message = raw.trim();

  if (message === "") {
    return err(new InvalidWelcomeMessageError(say.empty(LABEL)));
  }

  if (message.length > MAX_MESSAGE_LENGTH) {
    return err(new InvalidWelcomeMessageError(say.tooLong(LABEL, MAX_MESSAGE_LENGTH)));
  }

  // Catches `{usr}` for `{user}` — a typo that otherwise ships silently and
  // shows up as literal braces in front of every new member.
  const unknown = unknownIn(message, PLACEHOLDERS);

  if (unknown.length > 0) {
    return err(
      new InvalidWelcomeMessageError(
        say.notAllowedValue(
          "Placeholder",
          unknown[0] ?? "",
          `use ${PLACEHOLDER_NAMES.map((name) => `\`${name}\``).join(", ")}`,
        ),
      ),
    );
  }

  return ok(message);
}

/**
 * Whether a guild is actually greeting anyone.
 *
 * Derived, never stored as an independent flag: a guild greets people exactly
 * when it has both halves. A flag that could disagree with that is a flag that
 * eventually will, and the disagreement shows up as silence — the hardest kind
 * of failure to notice.
 */
export function isReady(settings: WelcomeSettings): boolean {
  return settings.message !== "" && settings.channelId !== null;
}

/** The empty configuration, so "never set up" and "cleared" are one shape. */
export function emptySettings(guildId: Snowflake): WelcomeSettings {
  return { guildId, channelId: null, message: "", enabled: false };
}

/**
 * Renders a saved message for a member.
 *
 * Pure and synchronous, which is what lets `/welcome` preview the exact text a
 * newcomer will see rather than an approximation of it. Driven by the catalogue
 * above, so a placeholder cannot be accepted by validation and then ignored
 * here.
 */
export function renderWelcome(message: string, context: WelcomeContext): string {
  return render(message, PLACEHOLDERS, context);
}
