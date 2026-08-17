import { describe, expect, it } from "vitest";

import { buildCustomId } from "#discord/contracts/custom-id.js";
import type { Response } from "#discord/contracts/response.contract.js";
import { renderForm, renderResponse, toPayload } from "#discord/ui/render.js";
import { Color, Icon, Limit } from "#discord/ui/tokens.js";

import { InfrastructureError, NotFoundError } from "#shared/errors/app-error.js";

/**
 * The design system's own suite.
 *
 * This is the one place a payload is asserted. Every feature asserts the
 * `Response` it returns and nothing more, which is why adding a feature does
 * not add rendering tests — and why changing the look of the bot is a change to
 * one file with one suite behind it.
 *
 * The rule these tests exist to hold: **everything the bot says about its own
 * work takes one frame, and the one thing a user wrote takes none of it.** It
 * is a rule that gets lost one reply at a time.
 */

const PRODUCTION = { showErrorDetail: false };
const DEVELOPMENT = { showErrorDetail: true };

function render(response: Response, options = PRODUCTION) {
  return renderResponse(response, options);
}

function embedOf(response: Response, options = PRODUCTION) {
  const rendered = render(response, options);
  const first = rendered.embeds[0];
  if (first === undefined) throw new Error("expected an embed");
  return { data: first.data, rendered };
}

describe("outcomes", () => {
  it("is one line in the description, with no title", () => {
    // The uniform: a glyph and a sentence, nothing else. A title would make a
    // confirmation a headline, and a headline wants a paragraph under it.
    const { data } = embedOf({ kind: "success", text: "Saved the welcome message." });

    expect(data.description).toBe(`${Icon.success} Saved the welcome message.`);
    expect(data.title).toBeUndefined();
    expect(data.fields).toBeUndefined();
    expect(data.footer).toBeUndefined();
  });

  it.each([
    ["success", `${Icon.success} Done.`, Color.success],
    // Neutral output is not an outcome: no glyph, no colour. Decorating
    // everything is how decoration stops meaning anything.
    ["info", "Done.", undefined],
    ["warning", `${Icon.warning} Done.`, Color.warning],
  ] as const)("badges and colours %s", (kind, line, color) => {
    const { data } = embedOf({ kind, text: "Done." });

    expect(data.description).toBe(line);
    expect(data.color).toBe(color);
  });

  it("carries buttons", () => {
    const { rendered } = embedOf({
      kind: "info",
      text: "Nothing configured yet.",
      actions: [{ label: "Edit", customId: buildCustomId("welcome", "edit-message") }],
    });

    expect(rendered.components[0]?.components).toHaveLength(1);
  });

  it("is public unless asked otherwise", () => {
    // A settings panel people can see is a settings panel people can find.
    expect(render({ kind: "info", text: "x" }).ephemeral).toBe(false);
    expect(render({ kind: "info", text: "x", visibility: "ephemeral" }).ephemeral).toBe(true);
  });

  it("never lets the bot's own words ping anyone", () => {
    // A confirmation that echoes an id back — "Saved <#123>." — must not
    // notify the channel it names.
    const payload = toPayload(render({ kind: "success", text: "Saved <@1> in <#2>." }));

    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  it("lays settings rows under the same sentence, in the same frame", () => {
    // A settings panel and a one-line confirmation are the same shape with
    // more in it, which is what makes the bot read as one bot.
    const { data } = embedOf({
      kind: "info",
      text: "Greeting new members in <#3>.",
      sections: [{ name: "Configuration", rows: [{ name: "Channel", value: "<#3>" }] }],
    });

    expect(data.description).toBe(
      "Greeting new members in <#3>.\n**Configuration**\n> -# **Channel:** <#3>",
    );
    // Markdown rather than embed fields: fields wrap into two ragged columns at
    // exactly the width a settings list stops being readable.
    expect(data.fields).toBeUndefined();
  });

  it("reads an unset row as n/a rather than hiding it", () => {
    // A settings screen is usually open *because* something is not set, so the
    // row has to exist before the setting does.
    const { data } = embedOf({
      kind: "info",
      text: "Not set up yet.",
      sections: [{ name: "Configuration", rows: [{ name: "Channel", value: "" }] }],
    });

    expect(data.description).toContain("> -# **Channel:** n/a");
  });
});

describe("user-authored text", () => {
  const greeting: Response = {
    kind: "text",
    content: "Welcome <@1> to Roki!",
    visibility: "public",
  };

  it("arrives exactly as written, with no icon and no box", () => {
    // The one response the bot does not put its own frame around: it is
    // somebody else's sentence.
    const rendered = render(greeting);

    expect(rendered.content).toBe("Welcome <@1> to Roki!");
    expect(rendered.embeds).toEqual([]);
  });

  it("resolves its mentions, because that is the point of {user}", () => {
    expect(toPayload(render(greeting)).allowedMentions.parse).toContain("users");
  });

  it("never resolves @everyone, whatever the template says", () => {
    // A welcome message is user-authored, and one that greeted every join with
    // a mass ping would be discovered by an entire server at once.
    const payload = toPayload(render({ kind: "text", content: "@everyone say hi!" }));

    expect(payload.allowedMentions.parse).not.toContain("everyone");
  });
});

describe("errors", () => {
  const error = new NotFoundError("No such ticket.", { detail: "ticket id=7 not in guild 9" });

  it("takes the same frame as everything else, and is private by default", () => {
    const { data, rendered } = embedOf({ kind: "error", error });

    expect(data.description).toBe(`${Icon.error} No such ticket.`);
    expect(data.color).toBe(Color.danger);
    expect(rendered.ephemeral).toBe(true);
  });

  it("never shows the detail in production", () => {
    expect(JSON.stringify(embedOf({ kind: "error", error }, PRODUCTION).data)).not.toContain(
      "ticket id=7",
    );
  });

  it("shows the detail in development, as small text under the message", () => {
    expect(embedOf({ kind: "error", error }, DEVELOPMENT).data.description).toContain(
      "-# ticket id=7 not in guild 9",
    );
  });

  it("never exposes an infrastructure detail, even in development", () => {
    // InfrastructureError's userMessage is generic by construction; the
    // connection string lives in detail and only ever reaches logs.
    const infra = new InfrastructureError("postgres://user:password@host/db refused");
    const { data } = embedOf({ kind: "error", error: infra }, PRODUCTION);

    expect(JSON.stringify(data)).not.toContain("password");
  });
});

describe("lists", () => {
  const items = [{ title: "First" }, { title: "Second", description: "with detail" }];

  it("keeps its box, because a list is structure", () => {
    const { data } = embedOf({
      kind: "list",
      title: "Tickets",
      items,
      page: { page: 1, pageCount: 1 },
    });

    expect(data.description).toContain("### Tickets");
    expect(data.description).toContain("**First**");
    expect(data.description).toContain("with detail");
  });

  it("shows an empty message and mutes the colour when there is nothing", () => {
    const { data } = embedOf({
      kind: "list",
      title: "Tickets",
      items: [],
      emptyMessage: "No open tickets.",
      page: { page: 1, pageCount: 1 },
    });

    expect(data.description).toContain("No open tickets.");
    expect(data.color).toBe(Color.muted);
  });

  it("shows the page only when there is more than one", () => {
    // Metadata is small text in the body, like everywhere else in the bot,
    // rather than a footer nothing but this uses.
    const single = embedOf({ kind: "list", title: "t", items, page: { page: 1, pageCount: 1 } });
    expect(single.data.description).not.toContain("Page");

    const paged = embedOf({ kind: "list", title: "t", items, page: { page: 2, pageCount: 5 } });
    expect(paged.data.description).toContain("-# Page **2/5**");
  });

  it("renders page controls the feature supplied", () => {
    const { rendered } = embedOf({
      kind: "list",
      title: "t",
      items,
      page: { page: 2, pageCount: 5 },
      previous: { label: "Back", customId: buildCustomId("tickets", "page", "1") },
      next: { label: "Next", customId: buildCustomId("tickets", "page", "3") },
    });

    expect(rendered.components).toHaveLength(1);
    expect(rendered.components[0]?.components).toHaveLength(2);
  });
});

describe("confirmations", () => {
  const confirm: Response = {
    kind: "confirm",
    prompt: "Delete everything?",
    confirm: { label: "Delete", customId: buildCustomId("tickets", "wipe"), style: "danger" },
  };

  it("is always private, whatever the caller asked for", () => {
    // A destructive prompt visible to a channel invites someone else to answer
    // it.
    expect(render(confirm).ephemeral).toBe(true);
  });

  it("supplies a cancel button when the caller did not", () => {
    expect(render(confirm).components[0]?.components).toHaveLength(2);
  });

  it("takes the warning colour, because it is about to do something", () => {
    expect(embedOf(confirm).data.color).toBe(Color.warning);
    expect(embedOf(confirm).data.description).toBe(`${Icon.question} Delete everything?`);
  });
});

describe("silence", () => {
  it("renders nothing at all", () => {
    const rendered = render({ kind: "none" });

    expect(rendered.content).toBe("");
    expect(rendered.embeds).toEqual([]);
    expect(rendered.embeds).toEqual([]);
    expect(rendered.components).toEqual([]);
  });
});

describe("forms", () => {
  it("refuses to render as a message, and says what to do instead", () => {
    expect(() =>
      render({ kind: "form", form: { customId: "x:y:", title: "t", fields: [] } }),
    ).toThrow(/defer: "never"/);
  });
});

describe("Discord's limits", () => {
  it("truncates a long body rather than letting the API reject the message", () => {
    const { data } = embedOf({ kind: "success", text: "x".repeat(Limit.embedDescription + 50) });

    expect(data.description).toHaveLength(Limit.embedDescription);
    expect(data.description?.endsWith("…")).toBe(true);
  });
});

describe("renderForm", () => {
  const textField = {
    kind: "text",
    name: "reason",
    label: "Why?",
    style: "paragraph",
    maxLength: 500,
  } as const;

  function componentsOf(modal: ReturnType<typeof renderForm>) {
    return (modal.toJSON() as { components: { component: { custom_id?: string; type: number } }[] })
      .components;
  }

  it("wraps every field in a label", () => {
    // The label is what lets a modal hold a picker as well as a text box: the
    // question lives on the label, the answer on the component under it.
    const modal = renderForm({
      customId: buildCustomId("tickets", "close"),
      title: "Close ticket",
      fields: [textField],
    });
    const [first] = componentsOf(modal);

    expect(modal.toJSON().title).toBe("Close ticket");
    expect(first?.component.custom_id).toBe("reason");
  });

  it("builds a channel picker inside the form", () => {
    // The thing that makes "Edit channel" a popup with a dropdown in it rather
    // than a box asking someone to paste an id.
    const modal = renderForm({
      customId: buildCustomId("welcome", "edit-channel"),
      title: "Welcome channel",
      fields: [
        {
          kind: "pick",
          of: "channel",
          name: "channel",
          label: "Where new members are greeted",
          selected: ["300000000000000003"],
        },
      ],
    });
    const [first] = componentsOf(modal);
    const menu = first?.component as {
      type: number;
      channel_types?: number[];
      default_values?: { id: string; type: string }[];
      min_values?: number;
    };

    // ComponentType.ChannelSelect. GuildText, GuildAnnouncement, and threads —
    // a category in a "where should this go" picker is a choice that fails
    // later, at send time, in front of a member.
    expect(menu.type).toBe(8);
    expect(menu.channel_types).toEqual([0, 5, 11, 12]);
    expect(menu.default_values).toEqual([{ id: "300000000000000003", type: "channel" }]);
    expect(menu.min_values).toBe(1);
  });

  it("drops fields past the limit rather than losing the whole form", () => {
    const modal = renderForm({
      customId: buildCustomId("tickets", "close"),
      title: "t",
      fields: Array.from({ length: Limit.modalFields + 3 }, (_, index) => ({
        ...textField,
        name: `f${String(index)}`,
      })),
    });

    expect(componentsOf(modal)).toHaveLength(Limit.modalFields);
  });
});
