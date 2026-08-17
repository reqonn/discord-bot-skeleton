import { ValidationError } from "../../shared/errors/app-error.js";

import type { AuthorizationPolicy } from "./authorization.contract.js";
import type {
  AutocompleteChoice,
  AutocompleteContext,
  CommandContext,
} from "./context.contract.js";
import type { Response, Visibility } from "./response.contract.js";

/**
 * The minimum a validator must provide.
 *
 * Structural rather than a zod import, so this directory keeps its promise of
 * depending on nothing. A zod schema satisfies it as written, and so would any
 * Standard Schema implementation, which means swapping validators later is not
 * a rewrite of every command.
 */
export interface InputValidator<T> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: T }
    | {
        readonly success: false;
        readonly error: {
          readonly issues: readonly {
            readonly path: readonly PropertyKey[];
            readonly message: string;
          }[];
        };
      };
}

/**
 * When to acknowledge the interaction.
 *
 *   auto       arm a timer; defer only if the handler is still running when it
 *              fires. Fast commands reply directly with no "thinking…" flicker,
 *              slow ones cannot time out. This is the default and almost always
 *              the right answer.
 *   ephemeral  defer immediately, privately. For work known to be slow.
 *   public     defer immediately, visibly.
 *   never      do not defer. Required for a command that opens a modal, since
 *              Discord accepts a modal only as the first reply.
 */
export type DeferMode = "auto" | "ephemeral" | "public" | "never";

/**
 * A limit on how often a command may run.
 *
 * **Most commands should not have one, and the default is none.** A cooldown is
 * for a command whose cost lands on somebody else: it posts into a channel,
 * sends a DM, calls a paid API, or does work heavy enough to slow the bot down
 * for everyone. Those need a limit because the person being protected is not
 * the person clicking.
 *
 * A cheap read does not qualify, and putting one on it is actively harmful:
 * the commands people repeat are the ones they repeat *because something looks
 * wrong*, and refusing to answer "is the bot up?" the fourth time is the bot
 * failing exactly when it is being checked. Discord already rate-limits
 * interactions per user, and the outbound governor already stops the bot
 * spending a guild's send budget — so a cooldown on top of those is a third
 * limit protecting nothing.
 *
 * In this repository exactly one command declares one: `/welcome test`, which
 * posts a real message into a real channel.
 */
export interface CooldownSpec {
  /** What the limit is counted against. */
  readonly scope: "user" | "guild" | "channel" | "global";
  readonly limit: number;
  readonly windowMs: number;
}

interface BaseOption {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
}

export interface Choice {
  readonly name: string;
  readonly value: string | number;
}

/**
 * A slash command option, for registration with Discord.
 *
 * Declared separately from the input schema because the two answer different
 * questions: this one tells Discord what to render and pre-validate, the schema
 * tells us what is acceptable once it arrives — including cross-field rules
 * Discord cannot express. The overlap is small and the duplication is honest.
 */
export type OptionSpec =
  | (BaseOption & {
      readonly type: "string";
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly choices?: readonly Choice[];
      readonly autocomplete?: boolean;
    })
  | (BaseOption & {
      readonly type: "integer" | "number";
      readonly min?: number;
      readonly max?: number;
      readonly choices?: readonly Choice[];
      readonly autocomplete?: boolean;
    })
  | (BaseOption & { readonly type: "boolean" | "user" | "role" | "channel" });

/**
 * A registered command, as the registry and the pipeline see it.
 *
 * Deliberately **not** generic. The input type belongs to the handler, and
 * `defineCommand` closes over it — so the registry can hold commands with
 * wildly different inputs in one plain `Map` without generic variance games,
 * and reading this type does not require understanding any.
 *
 * `execute` takes raw options and validates them itself. That means a command
 * without validation is not something you can construct: it is not a rule to
 * remember, it is the only shape the factory produces.
 */
export interface CommandDescriptor {
  /** Space-separated for subcommands: "ticket open". */
  readonly name: string;
  readonly description: string;
  readonly options: readonly OptionSpec[];
  /**
   * A non-empty tuple on purpose: a command with no declared policy does not
   * compile. "Anyone may run this" is spelled `openToEveryone()`, so an open
   * command is a decision someone wrote down rather than a question nobody
   * asked.
   */
  readonly authorize: readonly [AuthorizationPolicy, ...AuthorizationPolicy[]];
  readonly cooldown?: CooldownSpec | undefined;
  readonly defer: DeferMode;
  readonly visibility: Visibility;

  /** Validates the raw options, then runs the handler. Built by defineCommand. */
  execute(context: CommandContext, rawOptions: Record<string, unknown>): Promise<Response>;

  /** Required when any option declares `autocomplete: true`. */
  autocomplete?:
    ((context: AutocompleteContext) => Promise<readonly AutocompleteChoice[]>) | undefined;
}

export interface CommandDefinition<TInput> {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly OptionSpec[];
  readonly input: InputValidator<TInput>;
  readonly authorize: readonly [AuthorizationPolicy, ...AuthorizationPolicy[]];
  readonly cooldown?: CooldownSpec;
  readonly defer?: DeferMode;
  readonly visibility?: Visibility;

  /**
   * Runs the command with validated input.
   *
   * Returns a description of what to say. It does not render anything and does
   * not reply — the pipeline does both, which is why every command's output
   * looks the same.
   */
  handle(context: CommandContext, input: TInput): Promise<Response>;

  readonly autocomplete?: (context: AutocompleteContext) => Promise<readonly AutocompleteChoice[]>;
}

/**
 * Declares a command.
 *
 * Defaults: no options, `defer: "auto"`, public. A bot people can see working
 * is the normal case, so it is the default; `visibility: "ephemeral"` marks the
 * output that is genuinely nobody else's business — a settings panel, a
 * personal total, a warning. Errors are private regardless, decided by the
 * renderer rather than by each command.
 */
export function defineCommand<TInput>(definition: CommandDefinition<TInput>): CommandDescriptor {
  return {
    name: definition.name,
    description: definition.description,
    options: definition.options ?? [],
    authorize: definition.authorize,
    cooldown: definition.cooldown,
    defer: definition.defer ?? "auto",
    visibility: definition.visibility ?? "public",

    execute: async (context, rawOptions) => {
      const parsed = definition.input.safeParse(rawOptions);
      if (!parsed.success) {
        // Rejected before the handler is reached, so a handler never has to
        // defend against malformed input.
        throw toValidationError(parsed.error.issues);
      }
      return definition.handle(context, parsed.data);
    },

    autocomplete: definition.autocomplete,
  };
}

/**
 * Turns validator issues into one user-facing message.
 *
 * Every issue is reported, not just the first: telling someone their subject is
 * too short, waiting for them to fix it, and then telling them the reason is
 * too long is a poor way to spend two round trips.
 */
function toValidationError(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): ValidationError {
  const described = issues
    .map((issue) => {
      const field = issue.path.map(String).join(".");
      return field === "" ? issue.message : `${field}: ${issue.message}`;
    })
    .join("\n");

  return new ValidationError(described === "" ? "That input is not valid." : described);
}
