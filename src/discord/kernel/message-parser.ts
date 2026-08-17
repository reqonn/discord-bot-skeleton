import type { OptionSpec } from "../contracts/command.contract.js";

/**
 * Turning `!ticket open "my subject"` into a command name and its options.
 *
 * Pure functions over strings, deliberately: this is the only part of message
 * handling with real logic in it, and keeping it free of discord.js means it is
 * tested by calling it rather than by standing up a gateway.
 *
 * The goal throughout is that `!ping` and `/ping` reach the *same* descriptor
 * with the same validated input. A prefix command is a second way in, never a
 * second implementation.
 */

export interface ParsedMessageCommand {
  /** The spoken command name, e.g. "ticket open". */
  readonly name: string;
  /** Everything after the name, already tokenised. */
  readonly args: readonly string[];
}

/** How many words a command name may span: "ticket open" is two. */
const MAX_NAME_WORDS = 3;

/**
 * Splits on whitespace, keeping quoted runs together.
 *
 * Without this, `!say "hello world"` is two arguments and the second half is
 * silently lost — the single most common surprise in prefix parsing. Both quote
 * characters are honoured because users type whichever their keyboard offers.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | undefined;

  for (const char of input) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current !== "") tokens.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  if (current !== "") tokens.push(current);
  return tokens;
}

/**
 * Resolves a message to a registered command, or undefined if it is not one.
 *
 * Longest match wins, so a bot with both `ticket` and `ticket open` routes
 * `!ticket open x` to the more specific of the two rather than passing "open"
 * as an argument to the general one.
 *
 * `isRegistered` is passed in rather than the registry itself: this file does
 * not need to know what a registry is, and the test does not need to build one.
 */
export function parseMessageCommand(
  content: string,
  prefix: string,
  isRegistered: (name: string) => boolean,
): ParsedMessageCommand | undefined {
  const trimmed = content.trim();
  if (!trimmed.startsWith(prefix)) return undefined;

  const tokens = tokenize(trimmed.slice(prefix.length));
  if (tokens.length === 0) return undefined;

  for (let words = Math.min(MAX_NAME_WORDS, tokens.length); words >= 1; words -= 1) {
    // Command names are lowercase; what someone types is their business.
    const name = tokens.slice(0, words).join(" ").toLowerCase();
    if (isRegistered(name)) return { name, args: tokens.slice(words) };
  }

  return undefined;
}

/**
 * Maps positional arguments onto declared options.
 *
 * Slash commands name their arguments; message commands cannot, so position is
 * all there is. Two rules make that bearable:
 *
 *   - a trailing `string` option swallows the rest, so `!remind 5 buy milk`
 *     works without quoting the reason
 *   - anything absent is omitted rather than set to undefined, leaving zod to
 *     apply its own defaults and produce its own "required" errors
 *
 * Type coercion here is deliberately loose — `"12"` becomes `12`, a mention
 * becomes an id — because zod is the thing that decides whether the result is
 * acceptable. Rejecting early would mean two places to keep in agreement.
 */
export function readMessageOptions(
  args: readonly string[],
  specs: readonly OptionSpec[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  specs.forEach((spec, index) => {
    if (index >= args.length) return;

    const isLast = index === specs.length - 1;
    const raw =
      isLast && spec.type === "string" ? args.slice(index).join(" ") : (args[index] ?? "");

    if (raw === "") return;
    values[spec.name] = coerce(raw, spec.type);
  });

  return values;
}

function coerce(raw: string, type: OptionSpec["type"]): unknown {
  switch (type) {
    case "integer":
    case "number": {
      const parsed = Number(raw);
      // NaN would satisfy `typeof x === "number"` and reach the handler as a
      // number that is not one. Passing the original string through instead
      // lets zod report the type error it exists to report.
      return Number.isNaN(parsed) ? raw : parsed;
    }

    case "boolean": {
      const lowered = raw.toLowerCase();
      if (["true", "yes", "y", "on", "1"].includes(lowered)) return true;
      if (["false", "no", "n", "off", "0"].includes(lowered)) return false;
      return raw;
    }

    case "user":
    case "channel":
    case "role":
      return extractId(raw);

    case "string":
      return raw;
  }
}

/**
 * Pulls the id out of a mention, or passes a bare id through.
 *
 * `<@123>`, `<@!123>`, `<#123>` and `<@&123>` all reduce to the digits, which
 * is what the slash path hands a feature — so a handler cannot tell which way
 * it was invoked, and that is the whole point.
 */
function extractId(raw: string): string {
  return /^<[@#][!&]?\d+>$/.test(raw) ? raw.replace(/\D/g, "") : raw;
}
