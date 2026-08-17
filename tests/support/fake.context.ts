import type {
  Actor,
  ChannelRef,
  GuildRef,
  PermissionName,
} from "#discord/contracts/actor.contract.js";
import type {
  CommandContext,
  ComponentContext,
  ModalContext,
} from "#discord/contracts/context.contract.js";
import type { Response, Visibility } from "#discord/contracts/response.contract.js";

import { asSnowflake } from "#shared/types/snowflake.types.js";

/**
 * What a handler did, captured for assertions.
 *
 * Adapter tests assert on the view model — "it returned an error response with
 * this code" — rather than on embed internals. Rendering is tested once, in the
 * design system's own suite, instead of re-tested in every feature.
 */
export interface CapturedInteraction {
  readonly followUps: Response[];
  deferred: Visibility | undefined;
}

export interface FakeContextOptions {
  readonly userId?: string;
  readonly displayName?: string;
  readonly guild?: GuildRef | null;
  readonly channel?: Partial<ChannelRef>;
  readonly permissions?: readonly PermissionName[];
  readonly roleIds?: readonly string[];
  readonly isGuildOwner?: boolean;
  readonly locale?: string;
  /** Null models the ~30s after a restart, before the first heartbeat. */
  readonly gatewayMs?: number | null;
  readonly elapsedMs?: number;
}

const DEFAULT_GUILD: GuildRef = { id: asSnowflake("100000000000000001"), name: "Test Guild" };

export function fakeActor(options: FakeContextOptions = {}): Actor {
  return {
    userId: asSnowflake(options.userId ?? "200000000000000002"),
    displayName: options.displayName ?? "Tester",
    isBot: false,
    roleIds: (options.roleIds ?? []).map(asSnowflake),
    permissions: new Set(options.permissions ?? []),
    isGuildOwner: options.isGuildOwner ?? false,
  };
}

/**
 * A CommandContext backed by nothing.
 *
 * This is the payoff of the contract boundary: a command handler is tested by
 * calling it with a plain object. There is no discord.js to mock, no client to
 * stand up, and no network — so adapter tests run in microseconds and stay
 * readable.
 */
export function fakeCommandContext(options: FakeContextOptions = {}): {
  context: CommandContext;
  captured: CapturedInteraction;
} {
  const captured: CapturedInteraction = { followUps: [], deferred: undefined };

  const context: CommandContext = {
    correlationId: "test-correlation",
    actor: fakeActor(options),
    guild: options.guild === undefined ? DEFAULT_GUILD : options.guild,
    channel: {
      id: asSnowflake("300000000000000003"),
      name: "general",
      parentId: null,
      ...options.channel,
    },
    locale: options.locale ?? "en-GB",
    latency: {
      // Fixed rather than measured: a test asserting on a real clock reads as
      // flaky the first time a machine is slow.
      gatewayMs: options.gatewayMs === undefined ? 42 : options.gatewayMs,
      elapsedMs: () => options.elapsedMs ?? 7,
    },
    defer: (visibility) => {
      captured.deferred = visibility ?? "ephemeral";
      return Promise.resolve();
    },
    followUp: (response) => {
      captured.followUps.push(response);
      return Promise.resolve();
    },
  };

  return { context, captured };
}

export function fakeComponentContext(
  options: FakeContextOptions & { payload?: string; originalUserId?: string } = {},
): { context: ComponentContext; captured: CapturedInteraction } {
  const { context: base, captured } = fakeCommandContext(options);

  return {
    captured,
    context: {
      ...base,
      payload: options.payload ?? "",
      messageId: asSnowflake("400000000000000004"),
      originalUserId:
        options.originalUserId === undefined ? undefined : asSnowflake(options.originalUserId),
    },
  };
}

export function fakeModalContext(
  options: FakeContextOptions & {
    payload?: string;
    values?: Record<string, string>;
    /** Ids a picker in the form returned, keyed by field name. */
    selected?: Record<string, string[]>;
  } = {},
): { context: ModalContext; captured: CapturedInteraction } {
  const { context: base, captured } = fakeCommandContext(options);

  return {
    captured,
    context: {
      ...base,
      payload: options.payload ?? "",
      values: options.values ?? {},
      selected: Object.fromEntries(
        Object.entries(options.selected ?? {}).map(([name, ids]) => [name, ids.map(asSnowflake)]),
      ),
    },
  };
}
