import type { AuthorizationPolicy } from "./authorization.contract.js";
import type { CooldownSpec, DeferMode } from "./command.contract.js";
import type { ComponentContext, ModalContext } from "./context.contract.js";
import type { Response } from "./response.contract.js";

/**
 * A button or select-menu handler.
 *
 * Routed by the `scope:action` prefix of the custom id. An interaction whose
 * scope matches nothing registered fails closed with a clear message rather
 * than being ignored — a button that silently does nothing is the worst
 * possible outcome for a user, and it is what happens by default when a
 * message outlives the deploy that created it.
 */
export interface ComponentDescriptor {
  /** Feature namespace, e.g. "tickets". Unique across the process. */
  readonly scope: string;
  /** What this button does, e.g. "close". Unique within the scope. */
  readonly action: string;

  readonly authorize: readonly [AuthorizationPolicy, ...AuthorizationPolicy[]];
  readonly cooldown?: CooldownSpec | undefined;
  readonly defer: DeferMode;

  /**
   * Whether only the user who triggered the original message may use this.
   *
   * Defaults to true, because the common bug is one user driving another
   * user's paginated list or confirming their destructive action. Shared
   * controls — a ticket panel everyone clicks — set it false explicitly.
   */
  readonly ownerOnly: boolean;

  handle(context: ComponentContext): Promise<Response>;
}

export interface ModalDescriptor {
  readonly scope: string;
  readonly action: string;
  readonly authorize: readonly [AuthorizationPolicy, ...AuthorizationPolicy[]];
  readonly defer: DeferMode;

  handle(context: ModalContext): Promise<Response>;
}

type ComponentDefinition = Omit<ComponentDescriptor, "defer" | "ownerOnly"> &
  Partial<Pick<ComponentDescriptor, "defer" | "ownerOnly">>;

export function defineComponent(definition: ComponentDefinition): ComponentDescriptor {
  return { defer: "auto", ownerOnly: true, ...definition };
}

type ModalDefinition = Omit<ModalDescriptor, "defer"> & Partial<Pick<ModalDescriptor, "defer">>;

export function defineModal(definition: ModalDefinition): ModalDescriptor {
  return { defer: "auto", ...definition };
}
