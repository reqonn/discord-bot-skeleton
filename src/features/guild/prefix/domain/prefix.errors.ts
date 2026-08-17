import { DomainError } from "#shared/errors/app-error.js";

/**
 * Failures this feature's rules can produce.
 *
 * Declared beside the rule that raises them rather than in a central error
 * file, so the feature stays deletable in one directory. The *wording* is not
 * declared here — it comes from `#shared/errors/phrasing.js`, which is what
 * makes this feature reject a too-long value in the same sentence every other
 * feature does.
 *
 * Codes are feature-namespaced and permanent: they reach logs, metrics labels
 * and support conversations, so they are treated as a public API.
 */
export class InvalidPrefixError extends DomainError {
  constructor(reason: string) {
    super({ code: "PREFIX_INVALID", userMessage: reason });
  }
}
