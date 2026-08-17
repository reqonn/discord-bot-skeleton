import { describe, expect, it } from "vitest";

import { GuildBudget } from "#discord/gateway/guild-budget.js";

function budget(windowMs = 1_000, max = 3) {
  let now = 0;
  return {
    budget: new GuildBudget(windowMs, max, () => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("GuildBudget", () => {
  it("starts empty", () => {
    const { budget: b } = budget();

    expect(b.usage("guild")).toBe(0);
    expect(b.hasCapacity("guild")).toBe(true);
  });

  it("counts actions inside the window", () => {
    const { budget: b } = budget();
    b.record("guild");
    b.record("guild");

    expect(b.usage("guild")).toBe(2);
  });

  it("reports exhaustion at the limit", () => {
    const { budget: b } = budget(1_000, 3);
    for (let i = 0; i < 3; i += 1) b.record("guild");

    expect(b.hasCapacity("guild")).toBe(false);
    expect(b.pressure("guild")).toBe(1);
  });

  it("forgets actions once they leave the window", () => {
    const { budget: b, advance } = budget(1_000, 3);
    b.record("guild");
    b.record("guild");

    advance(1_001);

    expect(b.usage("guild")).toBe(0);
    expect(b.hasCapacity("guild")).toBe(true);
  });

  it("expires only the part of the window that has passed", () => {
    const { budget: b, advance } = budget(1_000, 5);
    b.record("guild");
    advance(600);
    b.record("guild");
    advance(500); // the first is now 1100ms old, the second 500ms

    expect(b.usage("guild")).toBe(1);
  });

  it("isolates guilds from each other", () => {
    // The whole point: one busy server must not consume the allowance every
    // other server depends on.
    const { budget: b } = budget(1_000, 3);
    for (let i = 0; i < 3; i += 1) b.record("busy");

    expect(b.hasCapacity("busy")).toBe(false);
    expect(b.hasCapacity("quiet")).toBe(true);
  });

  it("reports pressure above 1 when over the limit", () => {
    const { budget: b } = budget(1_000, 2);
    for (let i = 0; i < 3; i += 1) b.record("guild");

    expect(b.pressure("guild")).toBe(1.5);
  });

  it("trims correctly under a large burst", () => {
    // Exercises the binary-search trim rather than the trivial path.
    const { budget: b, advance } = budget(1_000, 10_000);
    for (let i = 0; i < 500; i += 1) b.record("guild");
    advance(500);
    for (let i = 0; i < 200; i += 1) b.record("guild");
    advance(501);

    expect(b.usage("guild")).toBe(200);
  });

  it("forgets guilds that go quiet", () => {
    const { budget: b, advance } = budget(1_000, 3);
    b.record("guild");
    expect(b.trackedGuilds).toBe(1);

    advance(1_001);
    b.sweep();

    expect(b.trackedGuilds).toBe(0);
  });
});
