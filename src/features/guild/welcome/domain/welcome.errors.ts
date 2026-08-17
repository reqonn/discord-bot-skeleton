import { DomainError } from "#shared/errors/app-error.js";

/**
 * Failures this feature's rules can produce.
 *
 * One class per failure, because the class name is what appears in logs and
 * what a future caller would narrow on. The *wording* comes from
 * `#shared/errors/phrasing.js` rather than being written here, so this feature
 * phrases a rejection the same way every other feature does.
 *
 * Codes are feature-namespaced and permanent — they reach logs, metrics labels
 * and support conversations, so they are treated as a public API.
 */

export class InvalidWelcomeMessageError extends DomainError {
  constructor(reason: string) {
    super({ code: "WELCOME_INVALID_MESSAGE", userMessage: reason });
  }
}

export class WelcomeNotReadyError extends DomainError {
  constructor(reason: string) {
    super({ code: "WELCOME_NOT_READY", userMessage: reason });
  }
}
