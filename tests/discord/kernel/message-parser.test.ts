import { describe, expect, it } from "vitest";

import type { OptionSpec } from "#discord/contracts/command.contract.js";
import {
  parseMessageCommand,
  readMessageOptions,
  tokenize,
} from "#discord/kernel/message-parser.js";

/**
 * Message-command parsing.
 *
 * The only part of the message path with real logic in it, and the only part
 * that can silently do the wrong thing: a mis-parse does not throw, it runs a
 * command with the wrong arguments. Kept free of discord.js so it is tested by
 * calling it.
 */

const KNOWN = new Set(["ping", "ticket", "ticket open", "remind"]);
const isRegistered = (name: string): boolean => KNOWN.has(name);

const parse = (content: string, prefix = "!") => parseMessageCommand(content, prefix, isRegistered);

describe("tokenize", () => {
  it("splits on whitespace", () => {
    expect(tokenize("a b  c")).toEqual(["a", "b", "c"]);
  });

  it("keeps a double-quoted run together", () => {
    // Without this, `!say "hello world"` quietly loses half its argument.
    expect(tokenize('say "hello world" now')).toEqual(["say", "hello world", "now"]);
  });

  it("keeps a single-quoted run together", () => {
    expect(tokenize("say 'hello world'")).toEqual(["say", "hello world"]);
  });

  it("survives an unclosed quote rather than dropping the rest", () => {
    expect(tokenize('say "hello world')).toEqual(["say", "hello world"]);
  });

  it("returns nothing for whitespace", () => {
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("parseMessageCommand", () => {
  it("recognises a bare command", () => {
    expect(parse("!ping")).toEqual({ name: "ping", args: [] });
  });

  it("ignores a message with no prefix", () => {
    expect(parse("ping")).toBeUndefined();
  });

  it("ignores an unknown command", () => {
    // Critical: a chat message that happens to start with ! must not be
    // answered, or the bot replies to ordinary conversation.
    expect(parse("!definitely-not-a-command")).toBeUndefined();
  });

  it("ignores the prefix on its own", () => {
    expect(parse("!")).toBeUndefined();
  });

  it("tolerates leading whitespace", () => {
    expect(parse("   !ping")).toEqual({ name: "ping", args: [] });
  });

  it("is case-insensitive about what was typed", () => {
    expect(parse("!PING")).toEqual({ name: "ping", args: [] });
  });

  it("collects arguments after the name", () => {
    expect(parse("!remind 5 buy milk")).toEqual({ name: "remind", args: ["5", "buy", "milk"] });
  });

  it("prefers the longest matching command name", () => {
    // Both "ticket" and "ticket open" are registered. The specific one wins,
    // rather than "open" arriving as an argument to the general one.
    expect(parse("!ticket open subject")).toEqual({ name: "ticket open", args: ["subject"] });
  });

  it("falls back to the shorter name when the longer is not registered", () => {
    expect(parse("!ticket close")).toEqual({ name: "ticket", args: ["close"] });
  });

  it("honours a multi-character prefix", () => {
    expect(parse("bot!ping", "bot!")).toEqual({ name: "ping", args: [] });
  });

  it("does not match a different prefix", () => {
    expect(parse("?ping")).toBeUndefined();
  });
});

describe("readMessageOptions", () => {
  const string = (name: string): OptionSpec => ({ type: "string", name, description: name });

  it("maps arguments onto options by position", () => {
    const specs: OptionSpec[] = [
      { type: "integer", name: "minutes", description: "" },
      string("text"),
    ];

    expect(readMessageOptions(["5", "buy", "milk"], specs)).toEqual({
      minutes: 5,
      // A trailing string option takes the remainder, so the common case needs
      // no quoting.
      text: "buy milk",
    });
  });

  it("omits options with no argument, leaving zod to decide", () => {
    const specs: OptionSpec[] = [string("a"), string("b")];

    expect(readMessageOptions(["only"], specs)).toEqual({ a: "only" });
  });

  it("returns nothing for a command that takes nothing", () => {
    expect(readMessageOptions(["stray", "words"], [])).toEqual({});
  });

  describe("coercion", () => {
    it("parses integers and numbers", () => {
      const specs: OptionSpec[] = [
        { type: "integer", name: "i", description: "" },
        { type: "number", name: "n", description: "" },
      ];

      expect(readMessageOptions(["42", "1.5"], specs)).toEqual({ i: 42, n: 1.5 });
    });

    it("passes a non-numeric value through so zod reports the type error", () => {
      // Coercing to NaN would satisfy `typeof x === "number"` and reach the
      // handler as a number that is not one.
      const specs: OptionSpec[] = [{ type: "integer", name: "i", description: "" }];

      expect(readMessageOptions(["soon"], specs)).toEqual({ i: "soon" });
    });

    it.each([
      ["true", true],
      ["yes", true],
      ["on", true],
      ["1", true],
      ["false", false],
      ["no", false],
      ["0", false],
    ])("reads %s as %s", (raw, expected) => {
      const specs: OptionSpec[] = [{ type: "boolean", name: "b", description: "" }];

      expect(readMessageOptions([raw], specs)).toEqual({ b: expected });
    });

    it.each([
      ["<@123456789012345678>", "user"],
      ["<@!123456789012345678>", "user"],
      ["<#123456789012345678>", "channel"],
      ["<@&123456789012345678>", "role"],
    ])("reduces the mention %s to its id", (mention, type) => {
      // The slash path hands a feature an id, so this one must too — a handler
      // cannot be able to tell how it was invoked.
      const specs: OptionSpec[] = [{ type: type as "user", name: "target", description: "" }];

      expect(readMessageOptions([mention], specs)).toEqual({ target: "123456789012345678" });
    });

    it("passes a bare id through unchanged", () => {
      const specs: OptionSpec[] = [{ type: "user", name: "target", description: "" }];

      expect(readMessageOptions(["123456789012345678"], specs)).toEqual({
        target: "123456789012345678",
      });
    });
  });
});
