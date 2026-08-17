import { describe, expect, it, vi } from "vitest";

import { onTerminalHangup, type HangupStream } from "#platform/lifecycle/hangup.js";

/** A stdin stand-in whose events a test can fire by hand. */
function fakeStream(isTTY: boolean | undefined): HangupStream & {
  emit(event: "end" | "close" | "error"): void;
  resumed: boolean;
} {
  const listeners = new Map<string, (() => void)[]>();

  return {
    isTTY,
    resumed: false,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return this;
    },
    resume() {
      this.resumed = true;
      return this;
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
}

describe("onTerminalHangup", () => {
  describe("when stdin is a terminal", () => {
    it.each(["end", "close", "error"] as const)("shuts down on %s", (event) => {
      const handler = vi.fn();
      const stream = fakeStream(true);

      expect(onTerminalHangup(stream, handler)).toBe(true);
      stream.emit(event);

      expect(handler).toHaveBeenCalledOnce();
    });

    it("resumes the stream, which is what makes it emit at all", () => {
      const stream = fakeStream(true);

      onTerminalHangup(stream, vi.fn());

      expect(stream.resumed).toBe(true);
    });

    it("shuts down once, even when several events fire", () => {
      // A closing console can produce an error and then a close. Shutdown is
      // not idempotent-free: running it twice races two teardowns.
      const handler = vi.fn();
      const stream = fakeStream(true);
      onTerminalHangup(stream, handler);

      stream.emit("error");
      stream.emit("close");
      stream.emit("end");

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe("when stdin is not a terminal", () => {
    it.each([
      ["piped or redirected", false],
      ["absent", undefined],
    ])("does not arm when stdin is %s", (_case, isTTY) => {
      // The production case, and the one that matters most: under a service
      // manager stdin is /dev/null and ends immediately. Arming here would
      // shut the bot down seconds after every deploy.
      const handler = vi.fn();
      const stream = fakeStream(isTTY);

      expect(onTerminalHangup(stream, handler)).toBe(false);

      stream.emit("end");
      expect(handler).not.toHaveBeenCalled();
    });

    it("leaves the stream paused, so it never holds the loop open", () => {
      const stream = fakeStream(false);

      onTerminalHangup(stream, vi.fn());

      expect(stream.resumed).toBe(false);
    });
  });
});
