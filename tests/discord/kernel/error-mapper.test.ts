import { DiscordAPIError } from "discord.js";
import { describe, expect, it } from "vitest";

import { isGone, isWorthReporting, toAppError } from "#discord/kernel/error-mapper.js";

import { DiscordError, InternalError, ValidationError } from "#shared/errors/app-error.js";

/** A Discord failure as the library raises it. */
function discordApiError(code: number, status = 404): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: `Discord says ${String(code)}` },
    code,
    status,
    "DELETE",
    "https://discord.example/api",
    {},
  );
}

describe("toAppError", () => {
  it("passes an AppError through untouched", () => {
    const original = new ValidationError("Pick a channel.");

    expect(toAppError(original)).toBe(original);
  });

  it("wraps a Discord failure as a DiscordError", () => {
    const wrapped = toAppError(discordApiError(50_013));

    expect(wrapped).toBeInstanceOf(DiscordError);
  });

  it("wraps anything else as an InternalError", () => {
    expect(toAppError(new Error("boom"))).toBeInstanceOf(InternalError);
    expect(toAppError("a string")).toBeInstanceOf(InternalError);
  });
});

describe("isGone", () => {
  it("recognises a thrown Discord failure", () => {
    expect(isGone(discordApiError(10_008))).toBe(true);
    expect(isGone(discordApiError(10_062))).toBe(true);
  });

  it("ignores a failure that means something else", () => {
    expect(isGone(discordApiError(50_013))).toBe(false);
    expect(isGone(new Error("boom"))).toBe(false);
    expect(isGone(undefined)).toBe(false);
  });

  describe("through the wrappers a failure actually arrives in", () => {
    it("sees a code the outbound limiter answered with", () => {
      // The limiter never throws: it answers a failure as a Result whose error
      // is `toAppError(cause)`. So by the time a caller asks this question the
      // DiscordAPIError is one layer down, and an `instanceof` check against
      // the wrapper is false for every code there is — which silently turns
      // "the message was deleted" into "an incident happened".
      const fromLimiter = toAppError(discordApiError(10_008));

      expect(isGone(fromLimiter)).toBe(true);
    });

    it("sees a code a gateway then re-wrapped as a fault", () => {
      // A gateway that raises the limiter's answer as its own fault adds a
      // second layer. The question is the same one and must have the same
      // answer.
      const fromLimiter = toAppError(discordApiError(10_003));
      const asFault = new DiscordError("The channel could not be read.", { cause: fromLimiter });

      expect(isGone(asFault)).toBe(true);
    });

    it("still says no when the wrapped code means something else", () => {
      const fromLimiter = toAppError(discordApiError(50_013));

      expect(isGone(fromLimiter)).toBe(false);
    });
  });
});

describe("isWorthReporting", () => {
  it("reports a fault", () => {
    expect(isWorthReporting(new InternalError("a bug"))).toBe(true);
  });

  it("stays quiet about a refusal", () => {
    // Logging these at error level trains people to ignore the error level,
    // which is how a real incident gets missed.
    expect(isWorthReporting(new ValidationError("Pick a channel."))).toBe(false);
  });
});
