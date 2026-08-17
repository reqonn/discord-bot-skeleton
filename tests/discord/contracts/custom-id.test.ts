import { describe, expect, it } from "vitest";

import {
  buildCustomId,
  componentKey,
  CUSTOM_ID_MAX_LENGTH,
  parseCustomId,
} from "#discord/contracts/custom-id.js";

describe("custom ids", () => {
  describe("buildCustomId", () => {
    it("joins scope, action, and payload", () => {
      expect(buildCustomId("tickets", "close", "abc123")).toBe("tickets:close:abc123");
    });

    it("allows an empty payload", () => {
      expect(buildCustomId("tickets", "open")).toBe("tickets:open:");
    });

    it("accepts kebab-case segments", () => {
      expect(buildCustomId("guild-settings", "set-prefix", "x")).toBe(
        "guild-settings:set-prefix:x",
      );
    });

    it("rejects a segment that would break parsing", () => {
      expect(() => buildCustomId("tick:ets", "close")).toThrow(/kebab-case/);
      expect(() => buildCustomId("Tickets", "close")).toThrow(/kebab-case/);
      expect(() => buildCustomId("tickets", "Close")).toThrow(/kebab-case/);
    });

    it("rejects an id Discord would reject, and says what to do instead", () => {
      // Discord drops the entire message when an id is too long, with no error
      // that points at the cause. Failing at construction is far kinder.
      const tooLong = "x".repeat(CUSTOM_ID_MAX_LENGTH);

      expect(() => buildCustomId("tickets", "close", tooLong)).toThrow(/Store the state/);
    });

    it("accepts an id at exactly the limit", () => {
      const payload = "x".repeat(CUSTOM_ID_MAX_LENGTH - "tickets:close:".length);

      expect(buildCustomId("tickets", "close", payload)).toHaveLength(CUSTOM_ID_MAX_LENGTH);
    });
  });

  describe("parseCustomId", () => {
    it("round-trips what buildCustomId produced", () => {
      expect(parseCustomId(buildCustomId("tickets", "close", "abc"))).toEqual({
        scope: "tickets",
        action: "close",
        payload: "abc",
      });
    });

    it("keeps separators inside the payload", () => {
      expect(parseCustomId("tickets:close:a:b:c")?.payload).toBe("a:b:c");
    });

    it("returns an empty payload when there is none", () => {
      expect(parseCustomId("tickets:close:")?.payload).toBe("");
    });

    it("returns undefined for malformed input rather than throwing", () => {
      // Any user can send an arbitrary custom id; a malformed one is a routing
      // miss, not a crash.
      expect(parseCustomId("")).toBeUndefined();
      expect(parseCustomId("tickets")).toBeUndefined();
      expect(parseCustomId("tickets:")).toBeUndefined();
      expect(parseCustomId(":close:x")).toBeUndefined();
      expect(parseCustomId("Tickets:Close:x")).toBeUndefined();
    });
  });

  it("derives a registry key that matches what routing parses", () => {
    const parsed = parseCustomId(buildCustomId("tickets", "close", "abc"));

    expect(componentKey("tickets", "close")).toBe(
      componentKey(parsed?.scope ?? "", parsed?.action ?? ""),
    );
  });
});
