import type { Response } from "#discord/contracts/response.contract.js";

/**
 * Everything this feature says, in one file.
 *
 * The command decides *what happened*; this decides *how it reads*. Splitting
 * them is not ceremony — it is what stops `api/` becoming one file where policy,
 * orchestration and copy are interleaved, which is the state every command file
 * drifts into once a feature has more than one screen.
 *
 * Three things follow from having it:
 *
 *   - **Copy is reviewable.** Every string a user sees is on one screen, so
 *     changing tone, fixing a typo, or translating later is one file.
 *   - **Handlers stay short.** A command reads as policy → use case → present,
 *     with nothing in between to skip past.
 *   - **It is testable without Discord.** These are pure functions returning
 *     view models; the design system turns them into embeds, and that is
 *     tested once rather than per feature.
 *
 * Presenters return `Response` and never build an embed — that is RULE 4, and
 * it is why this file imports a contract rather than discord.js.
 *
 * **One sentence each.** The shape has nowhere to put a headline and a
 * paragraph, which is what keeps every reply in the bot the same size.
 */

export function prefixInForce(prefix: string, isDefault: boolean): Response {
  return {
    kind: "info",
    text: isDefault
      ? `### Prefix\nMessage commands use \`${prefix}\`, the default.`
      : `### Prefix\nMessage commands use \`${prefix}\`.`,
  };
}

export function prefixUpdated(prefix: string): Response {
  return {
    kind: "success",
    // Naming the command that now works ends the "did that do anything?"
    // question without the user having to guess at the next step.
    text: `Set the **prefix** to: \`${prefix}\``,
  };
}

export function prefixReset(defaultPrefix: string): Response {
  return {
    kind: "success",
    text: `Reset the **prefix** to: \`${defaultPrefix}\``,
  };
}
