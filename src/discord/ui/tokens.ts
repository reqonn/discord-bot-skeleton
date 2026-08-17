/**
 * The visual vocabulary. Every colour and glyph the bot shows comes from here.
 *
 * A hex literal or a raw emoji anywhere else is a bug: it is how a codebase
 * ends up with four slightly different greens and two different warning icons,
 * none of which anyone chose. Because features return view models rather than
 * embeds, they never need one — this file is consumed only by the renderer.
 */

/**
 * Semantic, not descriptive: `danger`, not `red`. Renaming a colour is then a
 * design decision rather than a find-and-replace, and a component asking for
 * `danger` keeps meaning the right thing when the palette changes.
 *
 * There is deliberately no brand colour. Colour here means something —
 * something worked, something needs attention, something failed — and neutral
 * output takes Discord's default so a skeleton ships no identity of its own.
 * Add one when the bot has a brand to express, and add it as a token here.
 */
export const Color = {
  success: 0x63ff7b,
  danger: 0xff4040,
  warning: 0xffd54e,
  /** Empty lists and anything switched off. */
  muted: 0x4f545c,
} as const;

export type ColorToken = keyof typeof Color;

/**
 * Leading glyphs.
 *
 * Unicode rather than custom application emoji, so the bot renders identically
 * in a server that has installed nothing. Swapping in your own is one edit
 * here: put `<:success:123…>` in these strings and every reply in the bot
 * changes at once, which is the reason they are tokens and not literals.
 *
 * There is deliberately **no info glyph**. Neutral output is not an outcome, so
 * it gets no badge and no colour — a bot that decorates every sentence has
 * stopped using decoration to mean anything.
 */
export const Icon = {
  success: "✅",
  error: "⛔",
  warning: "⚠️",
  question: "❓",
  bullet: "•",
  previous: "◀",
  next: "▶",
  empty: "—",
} as const;

export type IconToken = keyof typeof Icon;

/**
 * Discord's hard limits.
 *
 * Exceeding one causes the API to reject the whole message, so the renderer
 * truncates against these rather than letting a long ticket subject take down
 * the reply that contains it.
 */
export const Limit = {
  /** A message body. The default reply shape, so this is the common cap. */
  content: 2_000,
  embedTitle: 256,
  embedDescription: 4_096,
  fieldName: 256,
  fieldValue: 1_024,
  fieldCount: 25,
  buttonLabel: 80,
  selectPlaceholder: 150,
  modalTitle: 45,
  /** Labelled fields per modal. */
  modalFields: 5,
  /** Rows of components per message. Five buttons fit in each. */
  actionRows: 5,
} as const;

/** Trims to `max`, marking the cut so a truncated value never reads as complete. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
