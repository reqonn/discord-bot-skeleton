import { describe, expect, it } from "vitest";

import { MAX_PREFIX_LENGTH, parsePrefix } from "#features/guild/prefix/domain/prefix.rules.js";

/**
 * The domain layer, tested the way domain code should be.
 *
 * No fakes, no async, no setup — a string goes in, a decision comes out. This
 * is what "domain depends on nothing" buys: the rule is exercised directly, and
 * the test mentions no database, cache or Discord because the rule knows about
 * none of them. It is also the cheapest and most valuable suite in the repo.
 */
describe("parsePrefix", () => {
  it.each(["!", "?", ">>", "bot!", "$$$", "-"])("accepts %s", (raw) => {
    const result = parsePrefix(raw);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(raw);
  });

  it("trims rather than rejecting surrounding whitespace", () => {
    // Someone typing `/prefix to: ? ` meant `?`. Refusing over an invisible
    // character helps nobody.
    const result = parsePrefix("  ?  ");

    expect(result.ok && result.value).toBe("?");
  });

  it("accepts a prefix of exactly the maximum length", () => {
    // Boundaries are where off-by-one lives.
    const result = parsePrefix("x".repeat(MAX_PREFIX_LENGTH));

    expect(result.ok).toBe(true);
  });

  describe("rejections", () => {
    it("refuses an empty prefix", () => {
      // An empty prefix matches every message ever sent.
      const result = parsePrefix("   ");

      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.userMessage).toContain("empty");
    });

    it("refuses one character past the maximum", () => {
      const result = parsePrefix("x".repeat(MAX_PREFIX_LENGTH + 1));

      expect(!result.ok && result.error.userMessage).toContain("8 characters");
    });

    it("refuses internal whitespace", () => {
      // The parser splits on whitespace, so `"! x"` could never match anything.
      const result = parsePrefix("! x");

      expect(!result.ok && result.error.userMessage).toContain("spaces");
    });

    it("refuses to collide with Discord's own commands", () => {
      const result = parsePrefix("/");

      expect(!result.ok && result.error.userMessage).toContain("Discord");
    });

    it("refuses a prefix that would match a mention", () => {
      // `<` begins every mention, so the bot would answer anyone who merely
      // said its name.
      const result = parsePrefix("<@");

      expect(!result.ok && result.error.userMessage).toContain("mention");
    });
  });

  it("carries a stable, feature-namespaced code", () => {
    // Codes reach logs, metrics labels and support conversations, so they are
    // treated as a public API: add freely, rename never.
    const result = parsePrefix("");

    expect(!result.ok && result.error.code).toBe("PREFIX_INVALID");
  });

  it("marks the failure as expected, so it is not logged as a bug", () => {
    const result = parsePrefix("/");

    expect(!result.ok && result.error.severity).toBe("expected");
  });
});
