/**
 * Component custom ids: `scope:action:payload`.
 *
 * Lives with the contracts rather than the renderer because feature adapters
 * build ids (to describe buttons) and the kernel parses them (to route), and
 * neither should be reaching into the other's directory for the format.
 *
 * Discord caps a custom id at 100 characters and silently rejects the whole
 * message if it is exceeded — so the cap is enforced here, at construction,
 * where the stack trace points at the button that is too long. A test asserts
 * every id the codebase builds stays inside it.
 */

export const CUSTOM_ID_SEPARATOR = ":";
export const CUSTOM_ID_MAX_LENGTH = 100;

/** `scope` and `action` are identifiers; the payload may be anything else. */
const SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface ParsedCustomId {
  readonly scope: string;
  readonly action: string;
  /** Everything after the second separator. Empty when there is none. */
  readonly payload: string;
}

export function buildCustomId(scope: string, action: string, payload = ""): string {
  if (!SEGMENT_PATTERN.test(scope)) {
    throw new TypeError(`Custom id scope must be kebab-case: received "${scope}"`);
  }
  if (!SEGMENT_PATTERN.test(action)) {
    throw new TypeError(`Custom id action must be kebab-case: received "${action}"`);
  }

  const id = `${scope}${CUSTOM_ID_SEPARATOR}${action}${CUSTOM_ID_SEPARATOR}${payload}`;

  if (id.length > CUSTOM_ID_MAX_LENGTH) {
    // Failing here beats Discord rejecting the message: the payload is almost
    // always an id that should have been looked up rather than embedded.
    throw new TypeError(
      `Custom id "${id}" is ${String(id.length)} characters; Discord allows ${String(CUSTOM_ID_MAX_LENGTH)}. Store the state and put a key in the payload instead.`,
    );
  }

  return id;
}

/**
 * Parses an incoming custom id.
 *
 * Returns undefined for anything malformed rather than throwing, because the
 * input is untrusted: any user can send an arbitrary custom id, and a
 * malformed one is a routing miss, not a crash.
 */
export function parseCustomId(raw: string): ParsedCustomId | undefined {
  const first = raw.indexOf(CUSTOM_ID_SEPARATOR);
  if (first <= 0) return undefined;

  const second = raw.indexOf(CUSTOM_ID_SEPARATOR, first + 1);
  if (second <= first + 1) return undefined;

  const scope = raw.slice(0, first);
  const action = raw.slice(first + 1, second);
  if (!SEGMENT_PATTERN.test(scope) || !SEGMENT_PATTERN.test(action)) return undefined;

  return { scope, action, payload: raw.slice(second + 1) };
}

/** The registry key for a handler. Keeps routing and registration in agreement. */
export function componentKey(scope: string, action: string): string {
  return `${scope}${CUSTOM_ID_SEPARATOR}${action}`;
}
