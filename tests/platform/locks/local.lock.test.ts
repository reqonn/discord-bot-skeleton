import { describe, expect, it } from "vitest";

import { LocalLock } from "#platform/locks/local.lock.js";

describe("LocalLock", () => {
  it("runs work and returns its result", async () => {
    const lock = new LocalLock();

    await expect(lock.runExclusive("job", 1_000, () => Promise.resolve("done"))).resolves.toBe(
      "done",
    );
  });

  it("returns undefined when the lock is already held", async () => {
    const lock = new LocalLock();
    let release!: () => void;
    const first = lock.runExclusive(
      "job",
      1_000,
      () =>
        new Promise<string>(
          (resolve) =>
            (release = () => {
              resolve("first");
            }),
        ),
    );

    // undefined is a normal outcome: another holder is doing the work.
    await expect(
      lock.runExclusive("job", 1_000, () => Promise.resolve("second")),
    ).resolves.toBeUndefined();

    release();
    await expect(first).resolves.toBe("first");
  });

  it("releases the lock once work finishes", async () => {
    const lock = new LocalLock();

    await lock.runExclusive("job", 1_000, () => Promise.resolve(1));

    await expect(lock.runExclusive("job", 1_000, () => Promise.resolve(2))).resolves.toBe(2);
  });

  it("releases the lock when work throws", async () => {
    const lock = new LocalLock();

    await expect(
      lock.runExclusive("job", 1_000, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");

    // A failed run must not leave the job permanently locked out.
    await expect(lock.runExclusive("job", 1_000, () => Promise.resolve("after"))).resolves.toBe(
      "after",
    );
  });

  it("keeps different lock names independent", async () => {
    const lock = new LocalLock();
    let release!: () => void;
    const held = lock.runExclusive(
      "first",
      1_000,
      () => new Promise<void>((resolve) => (release = resolve)),
    );

    await expect(lock.runExclusive("second", 1_000, () => Promise.resolve("ok"))).resolves.toBe(
      "ok",
    );

    release();
    await held;
  });

  it("passes a signal that never aborts, because a local mutex cannot be lost", async () => {
    const lock = new LocalLock();

    const aborted = await lock.runExclusive("job", 1_000, (signal) =>
      Promise.resolve(signal.aborted),
    );

    expect(aborted).toBe(false);
  });
});
