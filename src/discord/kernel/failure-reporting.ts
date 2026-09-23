import type { Logger } from "../../platform/logging/logger.contract.js";
import { newIncidentId } from "../../shared/errors/incident-id.js";
import type { Response } from "../contracts/response.contract.js";

import { isGone, isWorthReporting, reportable, toAppError } from "./error-mapper.js";

/**
 * What happens to a failure the pipeline caught.
 *
 * Beside `pipeline.ts` rather than inside it. The pipeline owns the *order* of
 * a request and stays the one place that does; this is what is done with a
 * failure once that order has reached it. It moved out when the pipeline
 * reached its line ceiling, rather than the ceiling moving to make room.
 */

/** What reporting a failure needs. `PipelineDeps` satisfies it. */
export interface FailureReportingDeps {
  readonly logger: Logger;
}

/** What it needs from whatever failed. */
export interface FailedStep {
  readonly operation: string;
  readonly responder: { respond(response: Response): Promise<void> };
}

export type FailureOutcome = "expected_error" | "unexpected_error";

/**
 * Logs the failure and answers the person, and decides both once.
 *
 * A **refusal** is the person's to fix, and its sentence names what to change.
 * It is logged at info and shown as it is.
 *
 * A **fault** is the bot's, and the person can do nothing about it but report
 * it. So it gets an incident code: one string on the reply and on the log
 * line, which is what turns "it broke" into something an operator can look up.
 * The error's own `userMessage` never reaches them — only the logs — which is
 * why no fault is worded "please try again".
 */
export async function reportFailure(
  deps: FailureReportingDeps,
  error: unknown,
  step: FailedStep,
): Promise<FailureOutcome> {
  // Nobody is waiting: the interaction expired, or its target is gone.
  // Reporting it would fire every time somebody deletes a channel.
  if (isGone(error)) {
    deps.logger.debug("Gave up on a reply — nothing left to reply to", {
      operation: step.operation,
    });
    return "expected_error";
  }

  const appError = toAppError(error);
  const unexpected = isWorthReporting(appError);

  // A code for a fault only. A refusal gets none: "you need Manage Server" is
  // not a bug, and a code beside it invites reports of working behaviour.
  const incident = unexpected ? newIncidentId() : null;

  if (incident !== null) {
    deps.logger.error("Interaction failed", {
      incident,
      operation: step.operation,
      error: appError,
    });
  } else {
    deps.logger.info("Interaction rejected", {
      operation: step.operation,
      code: appError.code,
      reason: appError.detail ?? appError.userMessage,
    });
  }

  try {
    await step.responder.respond({
      kind: "error",
      error: incident === null ? appError : reportable(appError, incident),
    });
  } catch (replyError) {
    // Failing to deliver the reply is not worth a second incident; the first
    // is already recorded, and its code is what to look for.
    if (!isGone(replyError)) {
      deps.logger.warn("Could not deliver the error response", {
        ...(incident === null ? {} : { incident }),
        operation: step.operation,
        error: replyError,
      });
    }
  }

  return unexpected ? "unexpected_error" : "expected_error";
}
