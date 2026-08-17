import type { DeferMode } from "../contracts/command.contract.js";
import type { Visibility } from "../contracts/response.contract.js";

/**
 * When the adaptive defer fires.
 *
 * Discord allows 3 seconds to acknowledge an interaction. 1.2 s leaves a wide
 * margin for the round trip that follows, while being long enough that
 * essentially every healthy command replies directly and never shows a
 * "thinking…" state.
 */
export const AUTO_DEFER_AFTER_MS = 1_200;

/**
 * When a message command starts showing a typing indicator.
 *
 * Much shorter than the interaction threshold, because it is solving a
 * different problem. An interaction has a hard 3-second deadline and deferring
 * is how you survive it; a message has no deadline at all, so typing is purely
 * a courtesy — it says "heard you, working on it".
 *
 * That makes the trade-off the opposite way round. Firing early costs an extra
 * API call and a flicker of "…is typing" before an instant reply, so the bar is
 * "long enough that a human has started to wonder". Around 400 ms is where a
 * response stops feeling immediate, and nearly every command finishes well
 * inside it — so the common case sends nothing at all and simply replies.
 */
export const TYPING_AFTER_MS = 400;

export interface DeferPlan {
  /** Whether to acknowledge before running the handler at all. */
  readonly immediate: boolean;
  /** Whether to arm the adaptive timer. */
  readonly adaptive: boolean;
  readonly visibility: Visibility;
}

/**
 * Decides how an interaction gets acknowledged.
 *
 * The adaptive mode is the reason a slow handler cannot produce a failed
 * interaction: the timer guarantees an acknowledgement inside the budget
 * regardless of how long the handler takes, while a handler that finishes
 * first never pays for a deferral it did not need.
 *
 * The alternative approaches both have a real cost. Deferring everything makes
 * every command flash "thinking…" and turns a 40 ms reply into two round trips.
 * Deferring nothing means one slow query produces "The application did not
 * respond", which users read as the bot being broken.
 */
export function planDeferral(mode: DeferMode, visibility: Visibility): DeferPlan {
  switch (mode) {
    case "auto":
      return { immediate: false, adaptive: true, visibility };
    case "ephemeral":
      return { immediate: true, adaptive: false, visibility: "ephemeral" };
    case "public":
      return { immediate: true, adaptive: false, visibility: "public" };
    case "never":
      // Modals must be the first reply, so nothing may acknowledge before the
      // handler does.
      return { immediate: false, adaptive: false, visibility };
  }
}
