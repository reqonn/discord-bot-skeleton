import { describe, expect, it } from "vitest";

import { MemoryCooldownStore } from "#platform/ratelimit/memory.cooldown.js";

function store(): { store: MemoryCooldownStore; advance: (ms: number) => void } {
  let now = 0;
  return {
    store: new MemoryCooldownStore(() => now),
    advance: (ms) => {
      now += ms;
    },
  };
}

describe("MemoryCooldownStore", () => {
  it("allows attempts up to the limit", async () => {
    const { store: cooldowns } = store();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(cooldowns.hit("user:1", 3, 1_000)).resolves.toEqual({
        allowed: true,
        retryAfterMs: 0,
      });
    }
  });

  it("rejects the attempt past the limit and says when to retry", async () => {
    const { store: cooldowns, advance } = store();
    await cooldowns.hit("user:1", 2, 1_000);
    await cooldowns.hit("user:1", 2, 1_000);

    advance(400);

    await expect(cooldowns.hit("user:1", 2, 1_000)).resolves.toEqual({
      allowed: false,
      retryAfterMs: 600,
    });
  });

  it("keeps keys independent", async () => {
    const { store: cooldowns } = store();
    await cooldowns.hit("user:1", 1, 1_000);

    await expect(cooldowns.hit("user:2", 1, 1_000)).resolves.toMatchObject({ allowed: true });
  });

  it("opens a fresh window once the old one expires", async () => {
    const { store: cooldowns, advance } = store();
    await cooldowns.hit("user:1", 1, 1_000);
    await expect(cooldowns.hit("user:1", 1, 1_000)).resolves.toMatchObject({ allowed: false });

    advance(1_001);

    await expect(cooldowns.hit("user:1", 1, 1_000)).resolves.toMatchObject({ allowed: true });
  });

  it("counts rejected attempts, so hammering does not reset the window", async () => {
    const { store: cooldowns, advance } = store();
    await cooldowns.hit("user:1", 1, 1_000);

    advance(500);
    await cooldowns.hit("user:1", 1, 1_000); // rejected, still counted
    advance(400);

    // 900ms in: the window is the original one, not one restarted by the
    // rejected attempt.
    await expect(cooldowns.hit("user:1", 1, 1_000)).resolves.toEqual({
      allowed: false,
      retryAfterMs: 100,
    });
  });

  it("forgets everything on stop", async () => {
    const { store: cooldowns } = store();
    cooldowns.start();
    await cooldowns.hit("user:1", 1, 1_000);

    cooldowns.stop();

    await expect(cooldowns.hit("user:1", 1, 1_000)).resolves.toMatchObject({ allowed: true });
  });
});
