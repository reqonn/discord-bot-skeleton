import { say } from "#shared/errors/phrasing.js";
import { err, ok, type Result } from "#shared/result/result.js";

import { InvalidPrefixError } from "./prefix.errors.js";

/**
 * What makes a prefix usable.
 *
 * The one real rule this feature owns, and the reason it has a `domain/` at
 * all. Domain code is pure: a string goes in, a decision comes out. No
 * database, no clock, no Discord — which is why it is tested by calling it,
 * and why the same answer holds no matter who asks.
 *
 * Each rejection exists because of something it would break:
 *
 *   - **empty** — matches every message ever sent
 *   - **whitespace** — the parser splits on it, so `"! "` could never match
 *   - **`/`** — Discord's own command prefix; the bot would appear to fight it
 *   - **`<`** — begins every mention, so `<@123>` would parse as a command and
 *     the bot would answer anyone who merely said its name
 *
 * Returning `Result` rather than throwing is RULE 5: this is a failure the
 * caller is expected to handle, and the compiler should be able to prove it did.
 */

/** Longer than this stops being a prefix and starts being a word. */
export const MAX_PREFIX_LENGTH = 8;

/** What every message about a prefix calls it, so they all agree. */
const LABEL = "A prefix";

export function parsePrefix(raw: string): Result<string, InvalidPrefixError> {
  // Trimmed rather than rejected: someone typing `/prefix to: ?` meant `?`,
  // and refusing over an invisible character helps nobody.
  const prefix = raw.trim();

  if (prefix === "") {
    return err(new InvalidPrefixError(say.empty(LABEL)));
  }

  if (prefix.length > MAX_PREFIX_LENGTH) {
    return err(new InvalidPrefixError(say.tooLong(LABEL, MAX_PREFIX_LENGTH)));
  }

  if (/\s/.test(prefix)) {
    return err(new InvalidPrefixError(say.cannotContain(LABEL, "spaces")));
  }

  if (prefix.startsWith("/")) {
    return err(
      new InvalidPrefixError(
        say.cannotStartWith(LABEL, "/", "Discord owns that for its own commands"),
      ),
    );
  }

  if (prefix.startsWith("<")) {
    return err(
      new InvalidPrefixError(say.cannotStartWith(LABEL, "<", "every mention begins with it")),
    );
  }

  return ok(prefix);
}
