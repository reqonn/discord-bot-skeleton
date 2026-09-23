import { DiscordAPIError } from "discord.js";
import { describe, expect, it } from "vitest";

import type { Response } from "#discord/contracts/response.contract.js";
import { reportFailure, type FailedStep } from "#discord/kernel/failure-reporting.js";

import { AppError, InfrastructureError, ValidationError } from "#shared/errors/app-error.js";

import { MemoryLogger } from "#testing/memory.logger.js";

/** A responder that keeps what it was asked to say. */
function step(behaviour: "answers" | "throws" = "answers"): FailedStep & {
  readonly said: Response[];
} {
  const said: Response[] = [];
  return {
    operation: "command:ping",
    said,
    responder: {
      respond: (response) => {
        if (behaviour === "throws") return Promise.reject(new Error("could not reply"));
        said.push(response);
        return Promise.resolve();
      },
    },
  };
}

/**
 * A fault with a sentence of its own, distinct from the one the pipeline shows.
 *
 * The stock fault classes open the same way `say.unexpected` does, so an
 * assertion against them could not tell the two apart. This one can.
 */
class WidgetError extends AppError {
  constructor() {
    super({
      code: "WIDGET_DOWN",
      severity: "unexpected",
      userMessage: "The widget service is down.",
      detail: "widget-api returned 503",
    });
  }
}

/** The error an unexpected answer rendered, narrowed for assertions. */
function errorSaid(said: readonly Response[]) {
  const [response] = said;
  if (response?.kind !== "error") throw new Error("expected an error response");
  return response.error;
}

describe("reporting a fault", () => {
  it("answers with an incident code, and logs the same code", async () => {
    // One string in two places is the whole point: what the user quotes is
    // what the operator greps for.
    const logger = new MemoryLogger();
    const asked = step();

    const outcome = await reportFailure(
      { logger },
      new InfrastructureError("connection refused"),
      asked,
    );

    expect(outcome).toBe("unexpected_error");

    const logged = logger.find("Interaction failed");
    const incident = logged?.fields["incident"];
    expect(logged?.level).toBe("error");
    expect(typeof incident).toBe("string");

    expect(errorSaid(asked.said).userMessage).toContain(`\`${String(incident)}\``);
  });

  it("never shows the fault's own sentence", async () => {
    // A fault's `userMessage` is written for the logs. The user gets the
    // sentence that carries the code, and nothing that could be mistaken for
    // advice — the detail stays for a development render.
    const logger = new MemoryLogger();
    const asked = step();

    await reportFailure({ logger }, new WidgetError(), asked);

    const shown = errorSaid(asked.said);
    expect(shown.userMessage).not.toContain("widget");
    expect(shown.userMessage.toLowerCase()).not.toContain("try again");
    expect(shown.detail).toBe("widget-api returned 503");
    expect(shown.code).toBe("WIDGET_DOWN");
  });

  it("keeps the original as the cause, for the logs", async () => {
    const logger = new MemoryLogger();
    const asked = step();
    const original = new InfrastructureError("connection refused");

    await reportFailure({ logger }, original, asked);

    expect(errorSaid(asked.said).cause).toBe(original);
  });

  it("gives every fault a different code", async () => {
    const logger = new MemoryLogger();
    const first = step();
    const second = step();

    await reportFailure({ logger }, new Error("boom"), first);
    await reportFailure({ logger }, new Error("boom"), second);

    expect(errorSaid(first.said).userMessage).not.toBe(errorSaid(second.said).userMessage);
  });
});

describe("reporting a refusal", () => {
  it("shows the refusal as written, with no code, and logs at info", async () => {
    // "Pick a channel" is not a bug. A code beside it invites reports of the
    // bot working correctly.
    const logger = new MemoryLogger();
    const asked = step();
    const refusal = new ValidationError("Pick a **channel** first.");

    const outcome = await reportFailure({ logger }, refusal, asked);

    expect(outcome).toBe("expected_error");
    expect(errorSaid(asked.said)).toBe(refusal);
    expect(logger.messages("error")).toEqual([]);
    expect(logger.find("Interaction rejected")?.level).toBe("info");
  });
});

describe("when nobody is left to answer", () => {
  it("says nothing and does not treat it as a fault", async () => {
    const logger = new MemoryLogger();
    const asked = step();
    const expired = new DiscordAPIError(
      { code: 10_062, message: "Unknown interaction" },
      10_062,
      404,
      "POST",
      "https://discord.example",
      {},
    );

    const outcome = await reportFailure({ logger }, expired, asked);

    expect(outcome).toBe("expected_error");
    expect(asked.said).toEqual([]);
    expect(logger.hasProblems()).toBe(false);
  });
});

describe("when the reply itself fails", () => {
  it("logs once more with the same incident and still returns", async () => {
    const logger = new MemoryLogger();
    const asked = step("throws");

    await expect(reportFailure({ logger }, new InfrastructureError("down"), asked)).resolves.toBe(
      "unexpected_error",
    );

    const incident = logger.find("Interaction failed")?.fields["incident"];
    expect(logger.find("Could not deliver")?.fields["incident"]).toBe(incident);
  });
});
