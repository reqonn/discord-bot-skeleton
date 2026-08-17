import { describe, expect, it } from "vitest";

import { defineEvent } from "#discord/contracts/event.contract.js";

import { asSnowflake } from "#shared/types/snowflake.types.js";

/**
 * The gateway-event factory, executed.
 *
 * Like the component factories, this had no call site and no test. What it
 * mainly buys is the type link between `event` and the payload the handler
 * receives — the reason a feature subscribes to plain data rather than to a
 * discord.js `Channel` it would otherwise reach through. That link is worth an
 * assertion, because losing it would compile fine and quietly reopen the
 * containment boundary.
 */
describe("defineEvent", () => {
  it("narrows the payload to the event named", async () => {
    let seen: string | undefined;

    const descriptor = defineEvent({
      event: "guildJoined",
      name: "welcome.on-join",
      handle: (payload) => {
        // payload is GuildJoined here, not a union — `name` does not exist on
        // the other two events, so this line is the type link being asserted.
        seen = payload.name;
        return Promise.resolve();
      },
    });

    await descriptor.handle({
      guildId: asSnowflake("100000000000000001"),
      name: "Test Guild",
      memberCount: 12,
    });

    expect(seen).toBe("Test Guild");
  });

  it("carries the event name and subscriber name through unchanged", () => {
    const descriptor = defineEvent({
      event: "channelDeleted",
      name: "tickets.reconcile",
      handle: () => Promise.resolve(),
    });

    // The subscriber name is what makes two handlers on one event
    // distinguishable in logs.
    expect(descriptor).toMatchObject({ event: "channelDeleted", name: "tickets.reconcile" });
  });

  it("allows a null guild id, which is what a DM channel deletion carries", async () => {
    let received: unknown;
    const descriptor = defineEvent({
      event: "channelDeleted",
      name: "tickets.reconcile",
      handle: (payload) => {
        received = payload.guildId;
        return Promise.resolve();
      },
    });

    await descriptor.handle({ guildId: null, channelId: asSnowflake("300000000000000003") });

    expect(received).toBeNull();
  });
});
