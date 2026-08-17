/**
 * Substituting `{placeholders}` in text a user wrote.
 *
 * Generic over the context, so every feature that lets someone author a message
 * — welcome, leave, boost, autoresponders — gets the same substitution and the
 * same typo detection without writing either again.
 *
 * Pure and synchronous, and that is a deliberate ceiling rather than an
 * oversight. A placeholder that needs a Discord API call (an avatar, a member's
 * roles) does not belong in a catalogue: it would make this async, and then
 * every caller, and then the domain rules that use it. Resolve that kind of
 * value in `api/` first and pass it in as part of the context.
 */

/** Produces one placeholder's replacement from the context. */
export type Placeholder<TContext> = (context: TContext) => string;

/**
 * A named set of placeholders.
 *
 * The single source both rendering and validation read. Two lists would drift,
 * and the way anyone would discover that is a user being told a valid
 * placeholder is invalid.
 */
export type Catalogue<TContext> = Readonly<Record<string, Placeholder<TContext>>>;

/** Anything that looks like a placeholder, valid or not. Dots allowed. */
const TOKEN = /\{[a-z][a-z0-9._]*\}/gi;

export function namesOf<TContext>(catalogue: Catalogue<TContext>): string[] {
  return Object.keys(catalogue);
}

/**
 * Replaces every known placeholder, in a single pass.
 *
 * One pass rather than one `replaceAll` per entry, and the difference is not
 * performance. Replacing in sequence re-scans text that has already been
 * substituted, so a value containing something placeholder-shaped gets expanded
 * too — a member whose nickname is literally `{count}` would have it replaced by
 * the member count. Users choose their own names, so that is input, not a
 * curiosity.
 *
 * An unknown token is left exactly as written. Validation is what rejects those;
 * blanking them here would turn a visible typo into an invisible one.
 */
export function render<TContext>(
  text: string,
  catalogue: Catalogue<TContext>,
  context: TContext,
): string {
  const known = new Map(
    Object.entries(catalogue).map(([name, produce]) => [name.toLowerCase(), produce]),
  );

  return text.replace(TOKEN, (token) => {
    const produce = known.get(token.toLowerCase());
    return produce === undefined ? token : produce(context);
  });
}

/**
 * Tokens that look like placeholders but are not in the catalogue.
 *
 * This is what turns `{usr}` into an error at the moment someone saves, rather
 * than literal braces in front of every new member for the next six months.
 * Matching is case-insensitive because that is how people type, and the
 * catalogue is authoritative about the canonical spelling.
 */
export function unknownIn<TContext>(text: string, catalogue: Catalogue<TContext>): string[] {
  const known = new Set(namesOf(catalogue).map((name) => name.toLowerCase()));

  return [...text.matchAll(TOKEN)]
    .map((match) => match[0].toLowerCase())
    .filter((token) => !known.has(token));
}
