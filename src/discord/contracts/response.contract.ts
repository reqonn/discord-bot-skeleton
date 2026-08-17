import type { AppError } from "../../shared/errors/app-error.js";

/**
 * Who can see a response.
 *
 * Public is the default, because a bot whose replies nobody can see is a bot
 * nobody can tell is working. Ephemeral is the deliberate choice for output
 * that is genuinely private — a settings panel, someone's own totals — and it
 * is what every error takes regardless, decided once in the renderer so no
 * command can leak a failure into a busy channel by forgetting.
 */
export type Visibility = "public" | "ephemeral";

/**
 * One line of a settings card: a label and what it is set to.
 *
 * `value` may be empty and reads as "n/a" when it is — a settings screen is
 * usually open *because* something is not configured, so the row has to exist
 * before the setting does.
 */
export interface Row {
  readonly name: string;
  readonly value: string;
}

/** A group of rows under a bold header. */
export interface Section {
  readonly name: string;
  readonly rows: readonly Row[];
}

export interface ListItem {
  readonly title: string;
  readonly description?: string;
  /** Rendered before the title. A token from the emoji set, not a raw emoji. */
  readonly icon?: string;
}

export interface PageInfo {
  /** One-based, because it is shown to a human. */
  readonly page: number;
  readonly pageCount: number;
}

/** A button that maps to a component handler. */
export interface ActionRef {
  readonly label: string;
  /** Built with buildCustomId — never a hand-written string. */
  readonly customId: string;
  /**
   * Defaults to `secondary`, which is the neutral grey.
   *
   * Colour is meaning here, not decoration: `primary` marks the one action a
   * panel is steering toward, `danger` marks the one that destroys something.
   * A panel where every button is coloured has told the reader nothing.
   */
  readonly style?: "primary" | "secondary" | "danger";
  readonly icon?: string;
}

/**
 * One row of a form.
 *
 * Text and pickers are one ordered list rather than two, because a form has an
 * order and it is the author's. Splitting them would put every picker after
 * every text box no matter what the question actually is.
 */
export type FormField = TextField | PickerField;

export interface TextField {
  readonly kind: "text";
  /** The key this field's answer arrives under in `context.values`. */
  readonly name: string;
  readonly label: string;
  readonly style: "short" | "paragraph";
  readonly required?: boolean;
  readonly maxLength?: number;
  readonly minLength?: number;
  readonly placeholder?: string;
  readonly value?: string;
  /** A sentence under the label, for what the label has no room for. */
  readonly help?: string;
}

/**
 * A channel, role, or user chosen from Discord's own list.
 *
 * Discord resolves the options, so the bot never enumerates a guild's channels:
 * the ids arrive in `context.selected`, and the user gets search, permission
 * filtering and names that cannot go stale — none of which costs an API call.
 */
export interface PickerField {
  readonly kind: "pick";
  /** What is being chosen. Each maps to a different Discord select type. */
  readonly of: "channel" | "role" | "user";
  /** The key this field's ids arrive under in `context.selected`. */
  readonly name: string;
  readonly label: string;
  readonly placeholder?: string;
  /** Pre-selected, so the form opens showing what is already configured. */
  readonly selected?: readonly string[];
  readonly required?: boolean;
  readonly help?: string;
}

export interface FormSpec {
  readonly customId: string;
  readonly title: string;
  readonly fields: readonly FormField[];
}

/**
 * What a handler returns.
 *
 * A description of intent, not a Discord payload. Features cannot build embeds
 * or components — only say what kind of thing happened — and src/discord/ui
 * turns that into the one visual language the whole bot shares.
 *
 * This is what makes consistency structural. A feature cannot render an outcome
 * that looks different from every other outcome, because it never renders
 * anything. See docs/architecture.md RULE 4.
 */
export type Response =
  | OutcomeResponse
  | ErrorResponse
  | TextResponse
  | ListResponse
  | ConfirmResponse
  | FormResponse
  | SilentResponse;

/**
 * Something happened, and this is the one sentence that says so.
 *
 * **One sentence, not a headline and a paragraph.** A bot that answers
 * "Sent" over "Posted to the welcome channel." has spent two lines and a box
 * saying what `✅ Set the welcome message.` says in one, and every reply
 * written afterwards copies whichever it saw first. The shape is the rule:
 * there is nowhere to put a second line.
 *
 * `info` is the **default frame**: no glyph, no colour. It is what a settings
 * screen or an answer to a question takes, because neither is something that
 * *happened*. Success and warning are badged and coloured precisely so that
 * they stand out from it — a bot that decorates every reply has spent its
 * vocabulary on the replies that did not need it.
 *
 * `sections` is the escape hatch, and the only one. Supplying it means the
 * response has structure worth a box — a settings panel, a summary — and the
 * renderer promotes it to an embed with this sentence above the sections.
 * Everything else is sent as plain content, which is smaller on the wire,
 * faster to render on a phone, and reads like a person rather than a form.
 */
export interface OutcomeResponse {
  readonly kind: "success" | "info" | "warning";
  /**
   * One sentence, ending in a full stop. The glyph is added by the renderer.
   *
   * Optional only so that a card can be **sections alone** — `/ping` is the
   * example, where the numbers are the whole answer and a sentence above them
   * would be a label for something already labelled.
   */
  readonly text?: string;
  /**
   * Turns this into a settings card: bold headers over quoted rows.
   *
   * The escape hatch, and the only one. Everything else the bot says is the
   * sentence above and nothing more.
   */
  readonly sections?: readonly Section[];
  /**
   * Controls beneath the message.
   *
   * This is what lets a feature render a panel — an editor, a settings screen
   * — rather than only a paginated list or a yes/no prompt. The feature
   * supplies the buttons because it owns what they mean; the design system
   * decides how they look and where they go.
   */
  readonly actions?: readonly ActionRef[];
  readonly visibility?: Visibility;
}

/**
 * Carries the error itself, not a message.
 *
 * The renderer decides what the user sees — `userMessage` always, `detail` only
 * outside production — so no handler can leak internals by choosing the wrong
 * string.
 */
export interface ErrorResponse {
  readonly kind: "error";
  readonly error: AppError;
  readonly visibility?: Visibility;
}

/**
 * Text a *user* wrote, sent exactly as they wrote it.
 *
 * The one response with no icon, no colour, and no box. A welcome greeting is
 * the example: a server owner writes "Welcome {user} to {server}!" and expects
 * that message to arrive, not their sentence quoted inside the bot's chrome
 * with a tick in front of it. Decorating it would be the bot talking over the
 * person whose server it is.
 *
 * Mentions in it resolve — that is the point of `{user}` — but `@everyone` and
 * `@here` are stripped by the renderer, so a template can never become a mass
 * ping that nobody typed on purpose.
 */
export interface TextResponse {
  readonly kind: "text";
  readonly content: string;
  readonly visibility?: Visibility;
}

export interface ListResponse {
  readonly kind: "list";
  readonly title: string;
  readonly items: readonly ListItem[];
  readonly page: PageInfo;
  /** Shown instead of the list when it is empty. */
  readonly emptyMessage?: string;
  readonly visibility?: Visibility;

  /**
   * Page controls, supplied by the feature.
   *
   * The feature owns what "the next page" means — it holds the cursor and knows
   * how to fetch it — while the design system owns where the buttons go and
   * what they look like. Splitting it the other way would put query state in
   * the renderer.
   */
  readonly previous?: ActionRef;
  readonly next?: ActionRef;
}

export interface ConfirmResponse {
  readonly kind: "confirm";
  readonly prompt: string;
  readonly confirm: ActionRef;
  readonly cancel?: ActionRef;
  readonly visibility?: Visibility;
}

/**
 * Opens a modal — the popup form.
 *
 * The way to ask for anything: text, or a channel, role or user picked from
 * Discord's own list. There is deliberately no second way to show a picker. A
 * select sitting on the message under an embed is the obvious alternative, and
 * supporting both would mean two shapes for one question, drifting apart one
 * feature at a time.
 *
 * Discord only accepts a modal as the *first* reply to an interaction, so a
 * command or component returning this must declare `defer: "never"`. The
 * renderer fails loudly rather than silently dropping the modal if that rule is
 * broken.
 */
export interface FormResponse {
  readonly kind: "form";
  readonly form: FormSpec;
}

/**
 * Handled, with nothing to say.
 *
 * For a component handler whose only effect was elsewhere. Distinct from an
 * empty success, which would post a blank line.
 */
export interface SilentResponse {
  readonly kind: "none";
}
