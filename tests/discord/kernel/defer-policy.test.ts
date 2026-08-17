import { describe, expect, it } from "vitest";

import {
  AUTO_DEFER_AFTER_MS,
  planDeferral,
  TYPING_AFTER_MS,
} from "#discord/kernel/defer-policy.js";

describe("planDeferral", () => {
  it("arms the timer for auto, without acknowledging up front", () => {
    // The mode that makes a slow handler unable to produce a failed
    // interaction, while a fast one never shows "thinking…".
    expect(planDeferral("auto", "public")).toEqual({
      immediate: false,
      adaptive: true,
      visibility: "public",
    });
  });

  it.each([
    ["ephemeral", "ephemeral"],
    ["public", "public"],
  ] as const)("acknowledges immediately for %s", (mode, visibility) => {
    expect(planDeferral(mode, "public")).toEqual({
      immediate: true,
      adaptive: false,
      visibility,
    });
  });

  it("does neither for never, so a modal can still be the first reply", () => {
    expect(planDeferral("never", "ephemeral")).toEqual({
      immediate: false,
      adaptive: false,
      visibility: "ephemeral",
    });
  });
});

describe("the thresholds", () => {
  it("acknowledges an interaction well inside Discord's 3s deadline", () => {
    // The whole point of the interaction threshold: leave room for the reply
    // that follows, rather than acknowledging at 2.9s and losing the race.
    expect(AUTO_DEFER_AFTER_MS).toBeLessThan(3_000);
    expect(AUTO_DEFER_AFTER_MS).toBeGreaterThan(500);
  });

  it("shows typing much sooner than that, because it solves a different problem", () => {
    // A message has no deadline, so typing is a courtesy for slow work. It has
    // to fire around the point a human starts to wonder — far below the
    // interaction budget, or it would appear only after the reply already had.
    expect(TYPING_AFTER_MS).toBeLessThan(AUTO_DEFER_AFTER_MS);
    expect(TYPING_AFTER_MS).toBeLessThanOrEqual(500);
  });
});
