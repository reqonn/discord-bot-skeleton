import { randomBytes } from "node:crypto";

/**
 * A short code that ties what a user saw to what the logs recorded.
 *
 * "Something went wrong. Please try again." is a dead end for everybody: the
 * user has nothing to report, and an operator reading the logs cannot tell
 * which of the day's failures they are being told about. A code printed on the
 * reply and on the log line is what makes a report look-up-able.
 *
 * Base64url of ten random bytes: sixteen characters, no ambiguous punctuation,
 * and safe to double-click. Random rather than sequential because a counter
 * tells anybody who collects two of them how much traffic the bot serves, and
 * because two processes would have to agree on it.
 *
 * Not a hash of the error: two identical failures a day apart are two
 * incidents, and somebody reporting the second should not be told it is
 * already known.
 */
export function newIncidentId(): string {
  return randomBytes(10).toString("base64url");
}
