import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputStyle,
  type MessageActionRowComponentBuilder,
} from "discord.js";

import type { AppError } from "../../shared/errors/app-error.js";
import type {
  ActionRef,
  FormSpec,
  PickerField,
  Response,
  Section,
  TextField,
} from "../contracts/response.contract.js";

import { Color, Icon, Limit, truncate } from "./tokens.js";

/**
 * What to send, in the shape discord.js takes.
 *
 * `content` and `embeds` are alternatives, not a pair: a reply is one or the
 * other. See {@link renderResponse}.
 */
export interface RenderedMessage {
  readonly content: string;
  readonly embeds: EmbedBuilder[];
  readonly components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
  readonly ephemeral: boolean;
  /**
   * Whether mentions in `content` may notify anyone.
   *
   * False for everything the bot writes itself — an id echoed back in a
   * confirmation should not ping the person it names. True only for text a user
   * authored, and even then `@everyone` never resolves.
   */
  readonly mentions: boolean;
}

export interface RenderOptions {
  /**
   * Whether an error's internal `detail` is shown.
   *
   * True only outside production. This is the single switch that decides
   * whether a stack-adjacent string can reach a user, and it lives here rather
   * than at any call site so no handler can get it wrong.
   */
  readonly showErrorDetail: boolean;
}

/**
 * Turns a view model into a Discord payload.
 *
 * The only place in the codebase that constructs an embed or a component. That
 * is what makes the bot's output uniform: consistency is not a convention
 * people follow, it is the only path the code offers.
 *
 * **Everything the bot says about its own work is an embed; the one thing a
 * *user* wrote is not.** Every outcome is one line in the embed's description —
 * a glyph, then a sentence — with a coloured edge carrying the verdict. No
 * titles, no footers, no author rows: a title turns a confirmation into a
 * headline with a paragraph under it, and a paragraph is what a confirmation
 * grows into once there is somewhere to put one.
 *
 * A welcome greeting takes none of this, because it is somebody else's
 * sentence and quoting it back inside the bot's chrome is the bot talking over
 * the person whose server it is.
 */
export function renderResponse(response: Response, options: RenderOptions): RenderedMessage {
  switch (response.kind) {
    case "none":
      return blank();

    case "text":
      // Exactly what the user wrote. The only response the bot does not put its
      // own voice in front of.
      return {
        ...blank(),
        content: truncate(response.content, Limit.content),
        ephemeral: response.visibility === "ephemeral",
        mentions: true,
      };

    case "success":
    case "info":
    case "warning":
      return outcome(response, response.visibility === "ephemeral");

    case "error":
      return renderError(response.error, response.visibility !== "public", options);

    case "list":
      return renderList(response);

    case "confirm":
      return renderConfirm(response);

    case "form":
      // Modals are not messages; the pipeline calls renderForm instead. Reaching
      // here means a form response escaped that check.
      throw new TypeError(
        'A form response must be rendered with renderForm, not renderResponse. Declare the handler as defer: "never".',
      );
  }
}

/**
 * Builds the modal for a form response. Must be the first reply to an
 * interaction.
 *
 * Every field is wrapped in a Label, which is what lets a modal hold a picker
 * as well as a text box — the label carries the question, and the component
 * under it collects the answer. Fields past Discord's limit are dropped rather
 * than rejected, because a form missing its last question still works and a
 * rejected modal is a button that does nothing.
 */
export function renderForm(form: FormSpec): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(form.customId)
    .setTitle(truncate(form.title, Limit.modalTitle));

  modal.addLabelComponents(
    form.fields.slice(0, Limit.modalFields).map((field) => {
      const label = new LabelBuilder().setLabel(truncate(field.label, Limit.fieldName));
      if (field.help !== undefined) label.setDescription(truncate(field.help, Limit.fieldValue));

      return field.kind === "text" ? textField(label, field) : pickerField(label, field);
    }),
  );

  return modal;
}

function textField(label: LabelBuilder, field: TextField): LabelBuilder {
  return label.setTextInputComponent((input) => {
    input
      .setCustomId(field.name)
      .setStyle(field.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(field.required ?? true);

    if (field.maxLength !== undefined) input.setMaxLength(field.maxLength);
    if (field.minLength !== undefined) input.setMinLength(field.minLength);
    if (field.placeholder !== undefined) input.setPlaceholder(field.placeholder);
    if (field.value !== undefined) input.setValue(field.value);

    return input;
  });
}

/**
 * A picker inside the form.
 *
 * Channels are narrowed to the ones a bot can post in. Offering a category or
 * a forum in a "where should this be sent" picker is offering a choice that
 * fails later, at send time, in front of a member.
 *
 * `required` is expressed as a minimum of one choice, which is also how the
 * form refuses to submit empty — there is no separate validity flag to keep in
 * step with it.
 */
function pickerField(label: LabelBuilder, field: PickerField): LabelBuilder {
  const minValues = (field.required ?? true) ? 1 : 0;
  // Pre-selection is what makes a picker open on the current setting rather
  // than an empty box the reader has to compare against the panel behind it.
  const selected = [...(field.selected ?? [])];

  const configure = <TMenu extends BaseSelectMenu>(menu: TMenu): TMenu => {
    menu.setCustomId(field.name).setMinValues(minValues).setMaxValues(1);
    if (field.placeholder !== undefined) {
      menu.setPlaceholder(truncate(field.placeholder, Limit.selectPlaceholder));
    }
    return menu;
  };

  switch (field.of) {
    case "channel":
      return label.setChannelSelectMenuComponent((menu) =>
        configure(menu)
          .setChannelTypes([...POSTABLE_CHANNELS])
          .setDefaultChannels(selected),
      );
    case "role":
      return label.setRoleSelectMenuComponent((menu) => configure(menu).setDefaultRoles(selected));
    case "user":
      return label.setUserSelectMenuComponent((menu) => configure(menu).setDefaultUsers(selected));
  }
}

/** What every picker can be told, whatever it picks. */
interface BaseSelectMenu {
  setCustomId(id: string): this;
  setMinValues(count: number): this;
  setMaxValues(count: number): this;
  setPlaceholder(text: string): this;
}

const POSTABLE_CHANNELS = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
] as const;

/**
 * One line, and the settings rows under it when there are any.
 *
 * Success and warning are badged and coloured because something happened.
 * Neutral output is neither: it was asked for, so it takes Discord's default
 * frame and no glyph, and the reader's eye goes to the two kinds that matter.
 *
 * `sections` turn this into a settings card. They are rendered as markdown in
 * the same description rather than as embed fields, because fields wrap into
 * two ragged columns at exactly the width a settings list becomes unreadable —
 * and because `> -#` rows stay legible on a phone, which is where most people
 * will read them.
 */
function outcome(
  response: Extract<Response, { kind: "success" | "info" | "warning" }>,
  ephemeral: boolean,
): RenderedMessage {
  const glyph = ICONS[response.kind];
  const headline =
    response.text === undefined
      ? ""
      : glyph === undefined
        ? response.text
        : `${glyph} ${response.text}`;

  return {
    ...blank(),
    embeds: [
      embed(
        COLORS[response.kind],
        [headline, settings(response.sections)].filter((part) => part !== "").join("\n"),
      ),
    ],
    components: rows(response.actions),
    ephemeral,
  };
}

/**
 * A settings card body: bold section headers over quoted small-text rows.
 *
 *     **Message**
 *     > -# **Text:** Welcome {user} to {server}!
 *     > -# **Channel:** #general
 *
 * Unset reads `n/a` rather than being omitted, so the shape of what is
 * configurable is visible before any of it is configured — which is the whole
 * job of a settings screen someone has opened because they do not know yet.
 */
function settings(sections: readonly Section[] = []): string {
  return sections
    .flatMap((section) => [
      `**${section.name}**`,
      ...section.rows.map(
        (row: Section["rows"][number]) => `> -# **${row.name}:** ${row.value || "n/a"}`,
      ),
    ])
    .join("\n");
}

/**
 * A failure, in the same shape as everything else.
 *
 * The code goes in the footer because it is the handle a support conversation
 * needs and nothing a user has to read.
 */
function renderError(error: AppError, ephemeral: boolean, options: RenderOptions): RenderedMessage {
  // `detail` is written for an operator and may quote SQL, ids, or a driver
  // message. It is shown in development because it saves a log dive, and never
  // in production for exactly the same reason. `-#` is Discord's small-text
  // marker, so it sits under the message without competing with it.
  const detail =
    options.showErrorDetail && error.detail !== undefined ? `\n-# ${error.detail}` : "";

  return {
    ...blank(),
    embeds: [embed(Color.danger, `${Icon.error} ${error.userMessage}${detail}`)],
    ephemeral,
  };
}

function renderList(response: Extract<Response, { kind: "list" }>): RenderedMessage {
  const body =
    response.items.length === 0
      ? (response.emptyMessage ?? `${Icon.empty} Nothing to show.`)
      : response.items
          .map((item) => {
            const icon = item.icon ?? Icon.bullet;
            const description = item.description === undefined ? "" : `\n${item.description}`;
            return `${icon} **${item.title}**${description}`;
          })
          .join("\n");

  const page =
    response.page.pageCount > 1
      ? `\n-# Page **${String(response.page.page)}/${String(response.page.pageCount)}**`
      : "";

  // Muted only when empty — that is a state worth signalling.
  const built = embed(
    response.items.length === 0 ? Color.muted : null,
    `### ${response.title}\n${body}${page}`,
  );

  const controls = [response.previous, response.next].filter(
    (action): action is ActionRef => action !== undefined,
  );

  return {
    ...blank(),
    embeds: [built],
    components: rows(controls),
    ephemeral: response.visibility === "ephemeral",
  };
}

function renderConfirm(response: Extract<Response, { kind: "confirm" }>): RenderedMessage {
  const cancel: ActionRef = response.cancel ?? {
    label: "Cancel",
    customId: response.confirm.customId.replace(/:[^:]*:/, ":cancel:"),
  };

  return {
    ...blank(),
    embeds: [embed(Color.warning, `${Icon.question} ${response.prompt}`)],
    components: rows([response.confirm, cancel]),
    // Confirmations are always private: a destructive prompt visible to a
    // channel invites someone else to answer it.
    ephemeral: true,
  };
}

/** The empty payload every branch starts from, so no field is forgotten. */
function blank(): RenderedMessage {
  return { content: "", embeds: [], components: [], ephemeral: false, mentions: false };
}

/**
 * Buttons, chunked into rows of five.
 *
 * Five is Discord's limit per row, and silently dropping the sixth would be a
 * panel that looks fine in development and loses a control in production. Five
 * rows is the message limit, so anything past twenty-five is truncated rather
 * than rejected — a degraded panel beats no reply at all.
 */
function rows(
  actions: readonly ActionRef[] = [],
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  const built: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];

  for (let index = 0; index < actions.length && built.length < Limit.actionRows; index += 5) {
    built.push(row(actions.slice(index, index + 5)));
  }

  return built;
}

/**
 * An embed with everything in its description.
 *
 * `color` is null for neutral output, which leaves Discord's default frame
 * rather than picking a colour that would imply an outcome. Truncating rather
 * than letting Discord reject the whole message: a long value should degrade
 * the reply, not lose it.
 */
function embed(color: number | null, body: string): EmbedBuilder {
  const built = new EmbedBuilder().setDescription(truncate(body.trimEnd(), Limit.embedDescription));

  if (color !== null) built.setColor(color);
  return built;
}

function row(actions: readonly ActionRef[]): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    actions.map((action) => {
      const button = new ButtonBuilder()
        .setCustomId(action.customId)
        .setLabel(truncate(action.label, Limit.buttonLabel))
        .setStyle(BUTTON_STYLES[action.style ?? "secondary"]);

      if (action.icon !== undefined) button.setEmoji(action.icon);
      return button;
    }),
  );
}

/**
 * Neutral output has no glyph on purpose — see {@link Icon}. It is a settings
 * screen or an answer to a question, not something that happened.
 */
const ICONS: Record<"success" | "info" | "warning", string | undefined> = {
  success: Icon.success,
  info: undefined,
  warning: Icon.warning,
};

/**
 * Colour applies only to the embed form. Informational output takes Discord's
 * default frame, because colour here means an outcome and info is not one.
 */
const COLORS = {
  success: Color.success,
  info: null,
  warning: Color.warning,
} as const;

const BUTTON_STYLES = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  danger: ButtonStyle.Danger,
} as const;

/**
 * The message body, in the shape every send takes.
 *
 * One function so that the four places the bot writes — an interaction reply,
 * an edit, a message reply, and the messenger — cannot disagree about mentions.
 * That matters most for the thing it forbids: `@everyone` never resolves, so no
 * user-authored template can become a mass ping nobody typed on purpose.
 */
export function toPayload(rendered: RenderedMessage): {
  content: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
  allowedMentions: { parse: ("users" | "roles")[] };
} {
  return {
    content: rendered.content,
    embeds: rendered.embeds,
    components: rendered.components,
    allowedMentions: { parse: rendered.mentions ? ["users", "roles"] : [] },
  };
}
