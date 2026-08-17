import { describe, expect, it } from "vitest";

import { MEMBER_PLACEHOLDERS, type MemberContext } from "#shared/text/placeholders.js";
import { namesOf, render } from "#shared/text/template.js";
import { asSnowflake } from "#shared/types/snowflake.types.js";

/**
 * The shared member/server variables.
 *
 * Every one is derived rather than fetched, which is what keeps the catalogue
 * synchronous and usable from `domain/`. These tests are the proof of that:
 * nothing here needs a client, a network, or an await.
 */

// A real snowflake, so the derived timestamp is a real date.
const USER = asSnowflake("175928847299117063");

const CONTEXT: MemberContext = {
  userId: USER,
  userName: "ana",
  serverId: asSnowflake("200000000000000002"),
  serverName: "Test Guild",
  memberCount: 42,
  channelId: asSnowflake("300000000000000003"),
};

describe("MEMBER_PLACEHOLDERS", () => {
  it.each([
    ["{user}", `<@${USER}>`],
    ["{user.name}", "ana"],
    ["{user.id}", USER],
    ["{server}", "Test Guild"],
    ["{server.id}", "200000000000000002"],
    ["{server.count}", "42"],
    ["{server.ordinal}", "42nd"],
    ["{channel}", "<#300000000000000003>"],
  ])("renders %s", (name, expected) => {
    expect(render(name, MEMBER_PLACEHOLDERS, CONTEXT)).toBe(expected);
  });

  describe("{user.created}", () => {
    it("derives the account age from the id, with no API call", () => {
      // Discord ids carry their creation time. 175928847299117063 is the
      // documented example from Discord's own snowflake reference, which is
      // 2016-04-30T11:18:25.796Z.
      const rendered = render("{user.created}", MEMBER_PLACEHOLDERS, CONTEXT);

      expect(rendered).toBe("<t:1462015105.796:R>");
    });

    it("renders something usable for a malformed id rather than throwing", () => {
      // This runs while rendering a greeting. A wrong timestamp beats a
      // greeting nobody receives.
      const rendered = render("{user.created}", MEMBER_PLACEHOLDERS, {
        ...CONTEXT,
        userId: asSnowflake("not-a-snowflake"),
      });

      expect(rendered).toMatch(/^<t:\d+(\.\d+)?:R>$/);
    });
  });

  describe("{server.ordinal}", () => {
    it.each([
      [1, "1st"],
      [2, "2nd"],
      [3, "3rd"],
      [4, "4th"],
      // The teens are the case every naive version gets wrong: 11 ends in 1
      // and still takes "th".
      [11, "11th"],
      [12, "12th"],
      [13, "13th"],
      [21, "21st"],
      [111, "111th"],
    ])("renders %i as %s", (count, expected) => {
      expect(
        render("{server.ordinal}", MEMBER_PLACEHOLDERS, { ...CONTEXT, memberCount: count }),
      ).toBe(expected);
    });
  });

  it("renders {channel} as nothing when no channel is set, rather than braces", () => {
    // A greeting posted before a channel exists should read as a sentence with
    // a gap in it, not as a template someone forgot to fill in.
    expect(
      render("Say hi in {channel}", MEMBER_PLACEHOLDERS, { ...CONTEXT, channelId: null }),
    ).toBe("Say hi in ");
  });

  it("substitutes every name it advertises", () => {
    // The tie between the catalogue and reality: anything listed must actually
    // produce something, or a feature will accept it and then show braces.
    for (const name of namesOf(MEMBER_PLACEHOLDERS)) {
      expect(render(name, MEMBER_PLACEHOLDERS, CONTEXT)).not.toBe(name);
    }
  });
});
