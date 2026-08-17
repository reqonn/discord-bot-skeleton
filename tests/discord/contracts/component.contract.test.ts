import { describe, expect, it } from "vitest";

import { openToEveryone } from "#discord/contracts/authorization.contract.js";
import { defineComponent, defineModal } from "#discord/contracts/component.contract.js";

import { fakeComponentContext, fakeModalContext } from "#testing/fake.context.js";

/**
 * The button and modal factories, executed.
 *
 * These shipped with zero call sites and zero tests — nothing in the repo had
 * ever run them, yet they are the documented way to add the first button. An
 * extension point nobody has proven is worse than one that does not exist: the
 * person who reaches for it is the one who finds out.
 *
 * The defaults are the part worth pinning down. `ownerOnly` defaulting to true
 * is a security-relevant choice — it is what stops one user driving another
 * user's paginated list or confirming their destructive action — and a default
 * that silently flipped would be invisible in review.
 */
describe("defineComponent", () => {
  const base = {
    scope: "tickets",
    action: "close",
    authorize: [openToEveryone()] as const,
    handle: () => Promise.resolve({ kind: "none" as const }),
  };

  it("defaults ownerOnly to true, so controls are not shared by accident", () => {
    expect(defineComponent({ ...base }).ownerOnly).toBe(true);
  });

  it("lets a shared control opt out explicitly", () => {
    // A ticket panel everyone clicks. The point is that it takes a deliberate
    // `false` — the spread must not lose it against the default.
    expect(defineComponent({ ...base, ownerOnly: false }).ownerOnly).toBe(false);
  });

  it("defaults defer to auto", () => {
    expect(defineComponent({ ...base }).defer).toBe("auto");
  });

  it("honours an explicit defer mode", () => {
    expect(defineComponent({ ...base, defer: "never" }).defer).toBe("never");
  });

  it("carries scope, action, and policy through unchanged", () => {
    const descriptor = defineComponent({ ...base });

    expect(descriptor).toMatchObject({ scope: "tickets", action: "close" });
    expect(descriptor.authorize.map((policy) => policy.name)).toEqual(["openToEveryone"]);
  });

  it("produces a descriptor whose handler runs against a fake context", async () => {
    const descriptor = defineComponent({
      ...base,
      handle: (context) =>
        Promise.resolve({ kind: "success" as const, text: `closed by ${context.actor.userId}` }),
    });
    const { context } = fakeComponentContext({ userId: "700000000000000007" });

    await expect(descriptor.handle(context)).resolves.toMatchObject({
      kind: "success",
      text: "closed by 700000000000000007",
    });
  });

  it("gives the handler the parsed custom-id payload", async () => {
    const descriptor = defineComponent({
      ...base,
      handle: (context) => Promise.resolve({ kind: "info" as const, text: context.payload }),
    });
    const { context } = fakeComponentContext({ payload: "01HXYZ" });

    await expect(descriptor.handle(context)).resolves.toMatchObject({ text: "01HXYZ" });
  });
});

describe("defineModal", () => {
  const base = {
    scope: "tickets",
    action: "close-reason",
    authorize: [openToEveryone()] as const,
    handle: () => Promise.resolve({ kind: "none" as const }),
  };

  it("defaults defer to auto", () => {
    expect(defineModal({ ...base }).defer).toBe("auto");
  });

  it("honours an explicit defer mode", () => {
    expect(defineModal({ ...base, defer: "ephemeral" }).defer).toBe("ephemeral");
  });

  it("hands submitted values to the handler", async () => {
    const descriptor = defineModal({
      ...base,
      handle: (context) =>
        Promise.resolve({ kind: "success" as const, text: context.values["reason"] ?? "none" }),
    });
    const { context } = fakeModalContext({ values: { reason: "resolved" } });

    await expect(descriptor.handle(context)).resolves.toMatchObject({ text: "resolved" });
  });
});
