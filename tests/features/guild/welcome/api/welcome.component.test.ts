import { describe, expect, it } from "vitest";

import { MemoryCache } from "#platform/cache/memory.cache.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import type { ComponentDescriptor } from "#discord/contracts/component.contract.js";
import type { Response } from "#discord/contracts/response.contract.js";

import { createWelcomeComponents } from "#features/guild/welcome/api/welcome.component.js";
import { createWelcomeModals } from "#features/guild/welcome/api/welcome.modal.js";
import { Action } from "#features/guild/welcome/api/welcome.presenter.js";
import { ConfigureWelcomeUseCase } from "#features/guild/welcome/application/configure-welcome.usecase.js";

import { asSnowflake } from "#shared/types/snowflake.types.js";

import { fakeComponentContext, fakeModalContext } from "#testing/fake.context.js";
import { MemoryWelcomeRepository } from "#testing/memory.welcome.repository.js";

/**
 * The editor panel, driven the way a user drives it.
 *
 * Every step asserts the **view model** — "it returned the panel, with the
 * channel now set" — and never an embed. Rendering is tested once, in the
 * design system's own suite; a feature that re-tested it would be asserting
 * someone else's decisions.
 *
 * What this pins down is the flow the panel promises: three controls, no state
 * between clicks, and a picker whose choice lands on the configuration.
 */

const GUILD = asSnowflake("100000000000000001");
const CHANNEL = asSnowflake("300000000000000003");

function build() {
  const repository = new MemoryWelcomeRepository();
  const configure = new ConfigureWelcomeUseCase(repository, new MemoryCache(new MetricsRegistry()));

  const components = createWelcomeComponents(configure);
  const [message, channel] = createWelcomeModals(configure);
  if (message === undefined || channel === undefined) throw new Error("expected two modals");

  const find = (action: string): ComponentDescriptor => {
    const found = components.find((component) => component.action === action);
    if (found === undefined) throw new Error(`no component for ${action}`);
    return found;
  };

  return { repository, configure, find, modals: { message, channel } };
}

/** The panel's own labels, which are the thing a user actually sees. */
function labelsOf(response: Response): string[] {
  return response.kind === "info" ? (response.actions ?? []).map((action) => action.label) : [];
}

describe("the welcome editor panel", () => {
  it("offers exactly three controls, and colours only the destructive one", async () => {
    // Colour on a Discord button means something. The two edits are equal
    // choices and stay grey — which is what leaving `style` unset means —
    // while Reset is the one control that destroys what is configured.
    const { find } = build();
    const { context } = fakeComponentContext({ permissions: ["ManageGuild"] });

    const response = await find(Action.reset).handle(context);

    expect(labelsOf(response)).toEqual(["Edit message", "Edit channel", "Reset"]);
    expect(response.kind === "info" && (response.actions ?? []).map((a) => a.style)).toEqual([
      undefined,
      undefined,
      "danger",
    ]);
  });

  it("opens a form when asked to edit the message, seeded with what is there", async () => {
    const { find, configure } = build();
    await configure.setMessage(GUILD, "Hi {user}");
    const { context } = fakeComponentContext({ permissions: ["ManageGuild"] });

    const response = await find(Action.editMessage).handle(context);

    expect(response.kind).toBe("form");
    expect(response.kind === "form" && response.form.fields[0]).toMatchObject({
      kind: "text",
      value: "Hi {user}",
    });
  });

  it("opens a popup form holding a channel picker, rather than guessing", async () => {
    // The bug this replaced: the button used whichever channel the panel
    // happened to be open in, so "Edit channel" could not choose a channel.
    const { find, configure } = build();
    await configure.setChannel(GUILD, CHANNEL);
    const { context } = fakeComponentContext({ permissions: ["ManageGuild"] });

    const response = await find(Action.editChannel).handle(context);

    expect(response.kind).toBe("form");
    expect(response.kind === "form" && response.form.fields[0]).toMatchObject({
      kind: "pick",
      of: "channel",
      // Opens on what is configured, so the form shows the current answer
      // rather than an empty box.
      selected: [CHANNEL],
    });
  });

  it("stores what the picker in the form returns", async () => {
    const { modals, repository } = build();
    const { context } = fakeModalContext({
      permissions: ["ManageGuild"],
      selected: { channel: [CHANNEL] },
    });

    const response = await modals.channel.handle(context);

    expect(repository.settings.get(GUILD)?.channelId).toBe(CHANNEL);
    expect(response.kind).toBe("info");
  });

  it("re-renders unchanged when the form comes back with no choice", async () => {
    // Discord will not submit a required picker empty, but the answer arrives
    // over the wire and the wire is not a thing to trust.
    const { modals, repository } = build();
    const { context } = fakeModalContext({ permissions: ["ManageGuild"], selected: {} });

    const response = await modals.channel.handle(context);

    expect(response.kind).toBe("info");
    expect(repository.settings.get(GUILD)).toBeUndefined();
  });

  it("puts a configured guild back to nothing on reset", async () => {
    const { find, configure, repository } = build();
    await configure.setMessage(GUILD, "Hi {user}");
    await configure.setChannel(GUILD, CHANNEL);
    const { context } = fakeComponentContext({ permissions: ["ManageGuild"] });

    await find(Action.reset).handle(context);

    expect(repository.settings.get(GUILD)).toMatchObject({
      message: "",
      channelId: null,
      enabled: false,
    });
  });

  it("returns the panel from the form, so the message it came from re-renders", async () => {
    // The pipeline replaces a component's own message with whatever its
    // handler returns — including a modal raised by one. That is why this
    // returns the panel and not a "saved" notice.
    const { modals, repository } = build();
    const { context } = fakeModalContext({
      permissions: ["ManageGuild"],
      values: { message: "Welcome {user} to {server}" },
    });

    const response = await modals.message.handle(context);

    expect(response.kind).toBe("info");
    expect(repository.settings.get(GUILD)?.message).toBe("Welcome {user} to {server}");
  });

  it("reports a rejected message without losing the panel", async () => {
    // The domain refuses `{used}`; the pipeline shows that beside the panel
    // rather than replacing it, so there is still something to correct.
    const { modals } = build();
    const { context } = fakeModalContext({
      permissions: ["ManageGuild"],
      values: { message: "Hi {used}" },
    });

    const response = await modals.message.handle(context);

    expect(response.kind).toBe("error");
    expect(response.kind === "error" && response.error.code).toBe("WELCOME_INVALID_MESSAGE");
  });
});
