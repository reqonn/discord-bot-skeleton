import { describe, expect, it } from "vitest";

import { CircuitBreaker, circuitKey } from "#discord/gateway/circuit-breaker.js";

function breaker(failureThreshold = 3, windowMs = 1_000, cooldownMs = 5_000) {
  let now = 0;
  return {
    breaker: new CircuitBreaker({ failureThreshold, windowMs, cooldownMs }, () => now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const KEY = circuitKey("guild", "tickets");

describe("CircuitBreaker", () => {
  it("starts closed and allows calls", () => {
    const { breaker: b } = breaker();

    expect(b.state(KEY)).toBe("closed");
    expect(b.allows(KEY)).toBe(true);
  });

  it("stays closed below the threshold", () => {
    const { breaker: b } = breaker(3);
    b.recordFailure(KEY);
    b.recordFailure(KEY);

    expect(b.state(KEY)).toBe("closed");
    expect(b.allows(KEY)).toBe(true);
  });

  it("opens at the threshold and refuses calls", () => {
    const { breaker: b } = breaker(3);
    for (let i = 0; i < 3; i += 1) b.recordFailure(KEY);

    expect(b.state(KEY)).toBe("open");
    expect(b.allows(KEY)).toBe(false);
  });

  it("resets the count on success", () => {
    // A success proves the dependency works, so a slow trickle of failures
    // across an otherwise healthy hour must not accumulate into an open circuit.
    const { breaker: b } = breaker(3);
    b.recordFailure(KEY);
    b.recordFailure(KEY);
    b.recordSuccess(KEY);
    b.recordFailure(KEY);
    b.recordFailure(KEY);

    expect(b.state(KEY)).toBe("closed");
  });

  it("forgets failures older than the window", () => {
    const { breaker: b, advance } = breaker(3, 1_000);
    b.recordFailure(KEY);
    b.recordFailure(KEY);

    advance(1_001);
    b.recordFailure(KEY);

    expect(b.state(KEY)).toBe("closed");
  });

  it("isolates guilds and features from each other", () => {
    const { breaker: b } = breaker(3);
    const other = circuitKey("guild", "welcome");
    for (let i = 0; i < 3; i += 1) b.recordFailure(KEY);

    expect(b.allows(KEY)).toBe(false);
    expect(b.allows(other)).toBe(true);
    expect(b.allows(circuitKey("other-guild", "tickets"))).toBe(true);
  });

  describe("recovery", () => {
    it("admits exactly one probe after the cooldown", () => {
      const { breaker: b, advance } = breaker(3, 1_000, 5_000);
      for (let i = 0; i < 3; i += 1) b.recordFailure(KEY);

      advance(5_000);

      expect(b.state(KEY)).toBe("half-open");
      expect(b.allows(KEY)).toBe(true);
      // Everything else waits until the probe reports, so a recovering
      // dependency is not immediately re-flooded.
      expect(b.allows(KEY)).toBe(false);
    });

    it("closes when the probe succeeds", () => {
      const { breaker: b, advance } = breaker(3, 1_000, 5_000);
      for (let i = 0; i < 3; i += 1) b.recordFailure(KEY);
      advance(5_000);

      b.allows(KEY);
      b.recordSuccess(KEY);

      expect(b.state(KEY)).toBe("closed");
      expect(b.allows(KEY)).toBe(true);
    });

    it("restarts the cooldown when the probe fails", () => {
      const { breaker: b, advance } = breaker(3, 1_000, 5_000);
      for (let i = 0; i < 3; i += 1) b.recordFailure(KEY);
      advance(5_000);

      b.allows(KEY);
      b.recordFailure(KEY);

      expect(b.state(KEY)).toBe("open");
      expect(b.allows(KEY)).toBe(false);

      advance(5_000);
      expect(b.state(KEY)).toBe("half-open");
    });
  });

  it("counts open circuits for the metrics gauge", () => {
    const { breaker: b } = breaker(1);
    b.recordFailure(circuitKey("a", "tickets"));
    b.recordFailure(circuitKey("b", "tickets"));

    expect(b.openCount()).toBe(2);
  });

  it("forgets circuits nothing has touched", () => {
    const { breaker: b, advance } = breaker(1, 1_000, 5_000);
    b.recordFailure(KEY);

    advance(60_000);
    b.sweep();

    expect(b.openCount()).toBe(0);
  });
});
