import { describe, expect, it } from "vitest";

import { namesOf, render, unknownIn, type Catalogue } from "#shared/text/template.js";

/**
 * The substitution engine every authored message goes through.
 *
 * Generic and pure, so this suite needs nothing but strings and a plain object
 * — which is the whole reason it can be used from `domain/`.
 */

interface Ctx {
  readonly name: string;
  readonly count: number;
}

const CATALOGUE: Catalogue<Ctx> = {
  "{name}": (c) => c.name,
  "{count}": (c) => String(c.count),
  "{nested.value}": () => "deep",
};

const CONTEXT: Ctx = { name: "ana", count: 7 };

describe("render", () => {
  it("substitutes a placeholder", () => {
    expect(render("hi {name}", CATALOGUE, CONTEXT)).toBe("hi ana");
  });

  it("substitutes every occurrence, not just the first", () => {
    expect(render("{name} and {name}", CATALOGUE, CONTEXT)).toBe("ana and ana");
  });

  it("substitutes dotted names", () => {
    expect(render("go {nested.value}", CATALOGUE, CONTEXT)).toBe("go deep");
  });

  it("leaves text with no placeholders untouched", () => {
    expect(render("plain", CATALOGUE, CONTEXT)).toBe("plain");
  });

  it("leaves an unknown token alone rather than blanking it", () => {
    // Validation is what rejects these. Silently deleting one here would make a
    // typo invisible instead of merely wrong.
    expect(render("hi {nope}", CATALOGUE, CONTEXT)).toBe("hi {nope}");
  });

  it("does not re-substitute a value that looks like a placeholder", () => {
    // A user whose name is literally "{count}" must not become "7". Replacement
    // runs once per catalogue entry over the original text.
    const rendered = render("{name}", CATALOGUE, { name: "{count}", count: 7 });

    expect(rendered).toBe("{count}");
  });
});

describe("unknownIn", () => {
  it("finds a token the catalogue does not know", () => {
    expect(unknownIn("hi {nope}", CATALOGUE)).toEqual(["{nope}"]);
  });

  it("finds a mistyped dotted token", () => {
    // The case a looser pattern misses: `{nested.valu}` reads as ordinary text
    // unless dots are part of what counts as a token.
    expect(unknownIn("{nested.valu}", CATALOGUE)).toEqual(["{nested.valu}"]);
  });

  it("accepts a known token whatever the casing", () => {
    expect(unknownIn("{NAME}", CATALOGUE)).toEqual([]);
  });

  it("returns nothing for text with no tokens", () => {
    expect(unknownIn("plain text", CATALOGUE)).toEqual([]);
  });

  it("ignores braces that are not placeholder-shaped", () => {
    // JSON, code samples and emoticons all contain braces, and none of them are
    // a user getting a placeholder wrong.
    expect(unknownIn('{ "json": true } {} {1}', CATALOGUE)).toEqual([]);
  });
});

describe("namesOf", () => {
  it("lists the catalogue, for telling a user what is available", () => {
    expect(namesOf(CATALOGUE)).toEqual(["{name}", "{count}", "{nested.value}"]);
  });
});
