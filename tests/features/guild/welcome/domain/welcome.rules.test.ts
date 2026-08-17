import { describe, expect, it } from "vitest";

import {
  emptySettings,
  isReady,
  MAX_MESSAGE_LENGTH,
  parseWelcomeMessage,
  PLACEHOLDER_NAMES,
  renderWelcome,
} from "#features/guild/welcome/domain/welcome.rules.js";

import { asSnowflake } from "#shared/types/snowflake.types.js";

const GUILD = asSnowflake("100000000000000001");
const CHANNEL = asSnowflake("400000000000000004");

describe("parseWelcomeMessage", () => {
  it.each([
    "Welcome {user}!",
    "Hi {user}, you are our {server.ordinal} member of {server}",
    "no placeholders",
  ])("accepts %s", (raw) => {
    expect(parseWelcomeMessage(raw).ok).toBe(true);
  });

  it("rejects an empty message", () => {
    expect(parseWelcomeMessage("   ").ok).toBe(false);
  });

  it("rejects one past the maximum", () => {
    expect(parseWelcomeMessage("x".repeat(MAX_MESSAGE_LENGTH + 1)).ok).toBe(false);
  });

  it.each(PLACEHOLDER_NAMES)("accepts %s", (name) => {
    // Every advertised placeholder must survive validation. The pair of this
    // and the render test below is what keeps the catalogue honest from both
    // directions.
    expect(parseWelcomeMessage(`Hi ${name}`).ok).toBe(true);
  });

  it("catches a mistyped dotted placeholder, not just a plain one", () => {
    const result = parseWelcomeMessage("Hi {user.nme}");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.userMessage).toContain("{user.nme}");
  });

  it("catches a mistyped placeholder rather than shipping it", () => {
    // `{used}` for `{user}` would otherwise reach every new member as a
    // literal brace, and nobody would notice until someone complained.
    const result = parseWelcomeMessage("Hi {used}");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.userMessage).toContain("{used}");
  });
});

describe("isReady", () => {
  it("is true only with both halves", () => {
    const base = emptySettings(GUILD);

    expect(isReady(base)).toBe(false);
    expect(isReady({ ...base, message: "Hi" })).toBe(false);
    expect(isReady({ ...base, channelId: CHANNEL })).toBe(false);
    expect(isReady({ ...base, message: "Hi", channelId: CHANNEL })).toBe(true);
  });
});

describe("renderWelcome", () => {
  const CONTEXT = {
    userId: asSnowflake("77"),
    userName: "ana",
    serverId: GUILD,
    serverName: "Test",
    memberCount: 7,
    channelId: CHANNEL,
  };

  it("substitutes every placeholder, including repeats", () => {
    const rendered = renderWelcome(
      "{user} {user} aka {user.name} joined {server} — member {server.count}",
      CONTEXT,
    );

    expect(rendered).toBe("<@77> <@77> aka ana joined Test — member 7");
  });

  it("leaves a message with no placeholders alone", () => {
    expect(renderWelcome("plain text", CONTEXT)).toBe("plain text");
  });

  it("renders every name the catalogue advertises", () => {
    // Validation and rendering read the same catalogue, and this is the tie
    // between them: anything advertised as a placeholder must actually
    // substitute, or a user is told it is valid and then shown literal braces.
    for (const name of PLACEHOLDER_NAMES) {
      expect(renderWelcome(name, CONTEXT)).not.toContain(name);
    }
  });
});
