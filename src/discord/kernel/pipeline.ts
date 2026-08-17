import type {
  ChatInputCommandInteraction,
  Interaction,
  Message,
  MessageComponentInteraction,
  ModalSubmitInteraction,
} from "discord.js";

import type { RuntimeProfile } from "../../platform/config/config.js";
import {
  createRequestContext,
  runWithRequestContext,
  type RequestContext,
} from "../../platform/context/request-context.js";
import type { Logger } from "../../platform/logging/logger.contract.js";
import { Metric } from "../../platform/metrics/metrics.catalog.js";
import type { Metrics } from "../../platform/metrics/metrics.contract.js";
import type { CooldownStore } from "../../platform/ratelimit/cooldown.contract.js";
import { AuthorizationError, type AppError } from "../../shared/errors/app-error.js";
import { asSnowflake } from "../../shared/types/snowflake.types.js";
import type { AuthorizationPolicy } from "../contracts/authorization.contract.js";
import type { CooldownSpec } from "../contracts/command.contract.js";
import type { InteractionContext } from "../contracts/context.contract.js";
import { parseCustomId } from "../contracts/custom-id.js";
import type { Response } from "../contracts/response.contract.js";

import { handleAutocomplete } from "./autocomplete.handler.js";
import {
  buildCommandContext,
  buildComponentContext,
  buildModalContext,
  InteractionResponder,
  type AnyRepliableInteraction,
  type Responder,
} from "./context-factory.js";
import { AUTO_DEFER_AFTER_MS, planDeferral, TYPING_AFTER_MS } from "./defer-policy.js";
import { isGone, isWorthReporting, toAppError } from "./error-mapper.js";
import { enforceAuthorization, enforceCooldown } from "./guards.js";
import { buildMessageContext, MessageResponder } from "./message-context.js";
import { parseMessageCommand, readMessageOptions } from "./message-parser.js";
import { readOptions, resolveCommandName } from "./options.js";
import type { InteractionRegistry } from "./registry.js";

export interface PipelineDeps {
  readonly registry: InteractionRegistry;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly cooldowns: CooldownStore;
  readonly profile: RuntimeProfile;
  /** Message-command prefix, or undefined when they are turned off. */
  readonly prefix?: string | undefined;

  /**
   * A guild's own prefix, when it has set one.
   *
   * A function rather than a feature import, because the kernel must stay
   * feature-agnostic — it cannot depend on something a project may delete. The
   * composition root builds this and hands it over, so all the kernel knows is
   * "something that resolves a prefix", and a bot without the settings feature
   * simply does not pass one.
   */
  readonly guildPrefix?: (guildId: string) => Promise<string | undefined>;
}

/**
 * The single path every interaction takes.
 *
 *   resolve → context → cooldown → validate → authorize → defer → handle
 *           → present → render → send
 *
 * Cross-cutting concerns live here rather than in handlers, which is what keeps
 * a hundred commands behaving identically. Adding one — an audit log, a
 * maintenance gate — is a change to this file, not to every command.
 *
 * Nothing here throws to the caller. An interaction that fails must still
 * receive a reply, so every failure becomes a rendered error.
 *
 * **Over the 300-line ceiling, deliberately** (docs/conventions.md asks that
 * this be said rather than assumed). Four entry points — slash command,
 * message command, component, modal — each adapt their own input and then hand
 * over to one shared `run`. Splitting them into separate files would put the
 * four adapters somewhere other than the chain they exist to feed, which is the
 * arrangement this file is here to prevent: the value is that every route
 * through the bot is readable in one place. The duplication the ceiling was
 * warning about is real and was removed — `open` and `renderOptions` — and what
 * remains is length, not repetition.
 */
export class InteractionPipeline {
  constructor(private readonly deps: PipelineDeps) {}

  /**
   * Opens the request context every entry point needs.
   *
   * Four handlers wanted the same eight lines with two words changed. Factored
   * out so that adding correlation, a counter, or a new label is one edit
   * rather than four that can disagree.
   */
  private open(
    source: RequestContext["source"],
    operation: string,
    guildId: string | null,
    userId: string,
  ): RequestContext {
    return createRequestContext(
      {
        source,
        operation,
        guildId: guildId === null ? undefined : asSnowflake(guildId),
        userId: asSnowflake(userId),
      },
      Date.now(),
    );
  }

  /** Render options are the same for every responder; profile owns the switch. */
  private get renderOptions(): { showErrorDetail: boolean } {
    return { showErrorDetail: this.deps.profile.showErrorDetail };
  }

  /**
   * The prefix in force for a guild.
   *
   * Runs for every message, so the resolver behind it is expected to be cached
   * — it is, through `getOrLoad`, which also single-flights a burst of misses
   * into one database read.
   *
   * A failure here falls back to the configured default rather than
   * propagating. The alternative is that a database blip stops every message
   * command in every guild, which is a far worse outcome than a few minutes of
   * a custom prefix not applying.
   */
  private async prefixFor(guildId: string | null): Promise<string> {
    const fallback = this.deps.prefix ?? "";
    if (this.deps.guildPrefix === undefined || guildId === null) return fallback;

    try {
      return (await this.deps.guildPrefix(guildId)) ?? fallback;
    } catch (error) {
      this.deps.logger.warn("Could not resolve the guild prefix; using the default", { error });
      return fallback;
    }
  }

  async handle(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) return this.handleCommand(interaction);
    if (interaction.isMessageComponent()) return this.handleComponent(interaction);
    if (interaction.isModalSubmit()) return this.handleModal(interaction);
    if (interaction.isAutocomplete()) {
      return handleAutocomplete(interaction, this.deps.registry, this.deps.logger);
    }
  }

  // ── Slash commands ─────────────────────────────────────────────────────────

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = resolveCommandName(interaction);
    const command = this.deps.registry.findCommand(name);

    if (command === undefined) {
      // Almost always a stale registration: the command exists in Discord but
      // not in this build. Fail closed and say so.
      await this.replyUnknown(interaction, `Unknown command: ${name}`);
      return;
    }

    const context = this.open("command", name, interaction.guildId, interaction.user.id);

    await runWithRequestContext(context, async () => {
      const responder = new InteractionResponder(interaction, this.renderOptions);
      const commandContext = buildCommandContext(interaction, context.correlationId, responder);

      await this.run({
        context,
        responder,
        interactionContext: commandContext,
        cooldown: command.cooldown,
        authorize: command.authorize,
        deferMode: command.defer,
        visibility: command.visibility,
        // Validation lives inside execute, built in by defineCommand, so a
        // command without it is not something that can be constructed.
        execute: () => command.execute(commandContext, readOptions(interaction, command.options)),
      });
    });
  }

  // ── Message commands ───────────────────────────────────────────────────────

  /**
   * Runs `!ping` through the same machinery as `/ping`.
   *
   * Everything below the parse is shared: the same descriptor, the same
   * cooldown and authorization guards, the same validation, the same handler,
   * the same rendering. A message command is a second way in, never a second
   * implementation — which is what stops the two drifting as features are
   * added, and why a new command gets both for free.
   */
  async handleMessage(message: Message): Promise<void> {
    const { prefix } = this.deps;
    if (prefix === undefined) return;

    // Bots include this bot: replying to our own output is an easy loop, and
    // the loop is only visible once it is running in a real server.
    if (message.author.bot) return;

    const parsed = parseMessageCommand(
      message.content,
      await this.prefixFor(message.guildId),
      (name) => this.deps.registry.findCommand(name) !== undefined,
    );
    if (parsed === undefined) return;

    const command = this.deps.registry.findCommand(parsed.name);
    if (command === undefined) return;

    const context = this.open("command", parsed.name, message.guildId, message.author.id);

    await runWithRequestContext(context, async () => {
      const responder = new MessageResponder(message, this.renderOptions);
      const messageContext = buildMessageContext(message, context.correlationId, responder);

      await this.run({
        context,
        responder,
        interactionContext: messageContext,
        cooldown: command.cooldown,
        authorize: command.authorize,
        // The command's own defer mode is deliberately ignored here. It exists
        // to survive Discord's 3-second interaction deadline, and a message has
        // no deadline — so a command declaring `defer: "public"` for that reason
        // must not be read as "always show a typing indicator". Typing is only
        // ever a courtesy for slow work, so the message route is always
        // adaptive and fires late enough that quick commands send nothing.
        deferMode: "auto",
        deferAfterMs: TYPING_AFTER_MS,
        // A message reply is always visible; there is no ephemeral to choose.
        visibility: "public",
        execute: () =>
          command.execute(messageContext, readMessageOptions(parsed.args, command.options)),
      });
    });
  }

  // ── Buttons and select menus ───────────────────────────────────────────────

  private async handleComponent(interaction: MessageComponentInteraction): Promise<void> {
    const parsed = parseCustomId(interaction.customId);
    const descriptor =
      parsed === undefined
        ? undefined
        : this.deps.registry.findComponent(parsed.scope, parsed.action);

    if (parsed === undefined || descriptor === undefined) {
      // A message outliving the build that created it is routine. A button that
      // silently does nothing is not acceptable, so say what happened.
      await this.replyUnknown(
        interaction,
        "This control is no longer active. Run the command again to get a fresh one.",
      );
      return;
    }

    const context = this.open(
      "component",
      `${parsed.scope}:${parsed.action}`,
      interaction.guildId,
      interaction.user.id,
    );

    await runWithRequestContext(context, async () => {
      const responder = new InteractionResponder(interaction, this.renderOptions);
      const componentContext = buildComponentContext(
        interaction,
        context.correlationId,
        parsed.payload,
        responder,
      );

      await this.run({
        context,
        responder,
        interactionContext: componentContext,
        cooldown: descriptor.cooldown,
        authorize: descriptor.authorize,
        deferMode: descriptor.defer,
        visibility: "ephemeral",
        execute: () => {
          // The common bug this prevents: one user driving another user's
          // paginated list, or confirming their destructive action.
          if (
            descriptor.ownerOnly &&
            componentContext.originalUserId !== undefined &&
            componentContext.originalUserId !== componentContext.actor.userId
          ) {
            throw new AuthorizationError("These controls belong to someone else.");
          }

          return descriptor.handle(componentContext);
        },
      });
    });
  }

  // ── Modal submissions ──────────────────────────────────────────────────────

  private async handleModal(interaction: ModalSubmitInteraction): Promise<void> {
    const parsed = parseCustomId(interaction.customId);
    const descriptor =
      parsed === undefined ? undefined : this.deps.registry.findModal(parsed.scope, parsed.action);

    if (parsed === undefined || descriptor === undefined) {
      await this.replyUnknown(interaction, "This form is no longer active.");
      return;
    }

    const context = this.open(
      "component",
      `${parsed.scope}:${parsed.action}`,
      interaction.guildId,
      interaction.user.id,
    );

    await runWithRequestContext(context, async () => {
      const responder = new InteractionResponder(interaction, this.renderOptions);
      const modalContext = buildModalContext(
        interaction,
        context.correlationId,
        parsed.payload,
        responder,
      );

      await this.run({
        context,
        responder,
        interactionContext: modalContext,
        cooldown: undefined,
        authorize: descriptor.authorize,
        deferMode: descriptor.defer,
        visibility: "ephemeral",
        execute: () => descriptor.handle(modalContext),
      });
    });
  }

  // ── The shared middleware chain ────────────────────────────────────────────

  private async run(step: {
    context: RequestContext;
    responder: Responder;
    interactionContext: InteractionContext;
    cooldown: CooldownSpec | undefined;
    authorize: readonly AuthorizationPolicy[];
    deferMode: Parameters<typeof planDeferral>[0];
    visibility: Parameters<typeof planDeferral>[1];
    /** How long to wait before acknowledging. Defaults to the interaction budget. */
    deferAfterMs?: number;
    execute: () => Promise<Response>;
  }): Promise<void> {
    const plan = planDeferral(step.deferMode, step.visibility);
    let deferTimer: NodeJS.Timeout | undefined;
    let outcome: "ok" | "expected_error" | "unexpected_error" = "ok";

    try {
      await enforceCooldown(this.deps.cooldowns, step.cooldown, step.interactionContext);
      enforceAuthorization(step.authorize, step.interactionContext);

      if (plan.immediate) await step.responder.defer(plan.visibility);

      if (plan.adaptive) {
        deferTimer = setTimeout(() => {
          void step.responder.defer(plan.visibility).catch(() => {
            // The interaction may already be answered or expired; the handler's
            // own reply will surface any real problem.
          });
          this.deps.metrics.increment(Metric.commandDeferredTotal, {
            operation: step.context.operation,
          });
        }, step.deferAfterMs ?? AUTO_DEFER_AFTER_MS);
      }

      const handlerStartedAt = performance.now();
      const response = await step.execute();
      this.deps.metrics.observe(
        Metric.commandHandlerDurationMs,
        performance.now() - handlerStartedAt,
        { operation: step.context.operation },
      );

      if (deferTimer !== undefined) clearTimeout(deferTimer);
      await step.responder.respond(response);
    } catch (error) {
      if (deferTimer !== undefined) clearTimeout(deferTimer);
      outcome = (await this.reportFailure(error, step.responder, step.context)) as typeof outcome;
    } finally {
      if (deferTimer !== undefined) clearTimeout(deferTimer);
      this.recordCompletion(step.context, outcome);
    }
  }

  /** Renders the failure and returns the outcome label for metrics. */
  private async reportFailure(
    error: unknown,
    responder: Responder,
    context: RequestContext,
  ): Promise<string> {
    if (isGone(error)) {
      // The interaction or its target vanished. There is nobody left to tell.
      this.deps.logger.debug("Interaction target no longer exists", {
        operation: context.operation,
      });
      return "expected_error";
    }

    const appError: AppError = toAppError(error);

    if (isWorthReporting(appError)) {
      this.deps.logger.error("Interaction failed", {
        error: appError,
        operation: context.operation,
      });
    } else {
      this.deps.logger.info("Interaction rejected", {
        operation: context.operation,
        code: appError.code,
      });
    }

    try {
      await responder.respond({ kind: "error", error: appError });
    } catch (replyError) {
      // Failing to deliver the error is not worth a second error; the original
      // is already recorded.
      this.deps.logger.warn("Could not deliver the error response", { error: replyError });
    }

    return isWorthReporting(appError) ? "unexpected_error" : "expected_error";
  }

  private recordCompletion(context: RequestContext, outcome: string): void {
    const durationMs = Date.now() - context.startedAt;
    const labels = { operation: context.operation, outcome };

    this.deps.metrics.increment(Metric.commandTotal, labels);
    this.deps.metrics.observe(Metric.commandAckDurationMs, durationMs, {
      operation: context.operation,
    });
    this.deps.metrics.observe(Metric.commandQueriesPerRequest, context.counters.queries, {
      operation: context.operation,
    });

    this.deps.logger.debug("Interaction complete", {
      durationMs,
      outcome,
      queries: context.counters.queries,
      queryMs: Math.round(context.counters.queryDurationMs),
      cacheHits: context.counters.cacheHits,
      cacheMisses: context.counters.cacheMisses,
    });
  }

  private async replyUnknown(interaction: AnyRepliableInteraction, message: string): Promise<void> {
    this.deps.logger.warn("Unroutable interaction", { detail: message });
    if (interaction.replied || interaction.deferred) return;

    try {
      await interaction.reply({ content: message, flags: ["Ephemeral"] });
    } catch {
      // Expired token. Nothing further to do.
    }
  }
}
