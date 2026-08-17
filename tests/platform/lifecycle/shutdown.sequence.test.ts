import { describe, expect, it } from "vitest";

import { ShutdownSequence } from "#platform/lifecycle/shutdown.sequence.js";

import { MemoryLogger } from "#testing/memory.logger.js";

describe("ShutdownSequence", () => {
  it("runs steps in reverse registration order", async () => {
    const order: string[] = [];
    const sequence = new ShutdownSequence(new MemoryLogger(), 1_000);

    sequence.add("database", () => {
      order.push("database");
    });
    sequence.add("redis", () => {
      order.push("redis");
    });
    sequence.add("flush-metrics", () => {
      order.push("flush-metrics");
    });

    await sequence.run("test");

    // Teardown mirrors startup: metrics were registered after Redis, so they
    // flush while Redis is still open.
    expect(order).toEqual(["flush-metrics", "redis", "database"]);
  });

  it("awaits asynchronous steps", async () => {
    const order: string[] = [];
    const sequence = new ShutdownSequence(new MemoryLogger(), 1_000);

    sequence.add("slow", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("slow");
    });
    sequence.add("fast", () => {
      order.push("fast");
    });

    await sequence.run("test");

    expect(order).toEqual(["fast", "slow"]);
  });

  it("continues after a failing step", async () => {
    const order: string[] = [];
    const logger = new MemoryLogger();
    const sequence = new ShutdownSequence(logger, 1_000);

    sequence.add("database", () => {
      order.push("database");
    });
    sequence.add("discord", () => {
      throw new Error("client refused to close");
    });

    const completed = await sequence.run("test");

    // A stuck Discord client must not leave the database pool open.
    expect(order).toEqual(["database"]);
    expect(completed).toBe(true);
    expect(logger.find("Shutdown step failed")).toBeDefined();
  });

  it("gives up at the deadline rather than hanging a deploy", async () => {
    const logger = new MemoryLogger();
    const sequence = new ShutdownSequence(logger, 20);

    sequence.add(
      "hangs",
      () =>
        new Promise<void>(() => {
          /* never resolves */
        }),
    );

    const completed = await sequence.run("test");

    expect(completed).toBe(false);
    expect(logger.find("Shutdown timed out")).toBeDefined();
  });

  it("ignores a second invocation", async () => {
    let runs = 0;
    const sequence = new ShutdownSequence(new MemoryLogger(), 1_000);
    sequence.add("step", () => {
      runs += 1;
    });

    await sequence.run("SIGTERM");
    await sequence.run("SIGINT");

    // A second signal while shutting down is normal; a second teardown is not.
    expect(runs).toBe(1);
  });

  it("reports the reason it was triggered", async () => {
    const logger = new MemoryLogger();
    const sequence = new ShutdownSequence(logger, 1_000);

    await sequence.run("SIGTERM");

    expect(logger.find("Shutting down")?.fields).toMatchObject({ reason: "SIGTERM" });
  });
});
