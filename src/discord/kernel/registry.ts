import type { CommandDescriptor } from "../contracts/command.contract.js";
import type { ComponentDescriptor, ModalDescriptor } from "../contracts/component.contract.js";
import { componentKey } from "../contracts/custom-id.js";
import type { EventDescriptor, EventName } from "../contracts/event.contract.js";

/**
 * Everything the kernel can dispatch to.
 *
 * Every collision is a boot failure rather than a last-registration-wins
 * overwrite. Silent shadowing is the standard failure mode of registries like
 * this, and it is miserable to diagnose: the command exists, it responds, and
 * it runs the wrong code. Refusing to start says so immediately, at the one
 * moment someone is looking.
 */
export class InteractionRegistry {
  private readonly commandsByName = new Map<string, CommandDescriptor>();
  private readonly componentsByKey = new Map<string, ComponentDescriptor>();
  private readonly modalsByKey = new Map<string, ModalDescriptor>();
  private readonly eventsByName = new Map<EventName, EventDescriptor[]>();

  registerCommand(descriptor: CommandDescriptor, featureId: string): void {
    const existing = this.commandsByName.get(descriptor.name);
    if (existing !== undefined) {
      throw new Error(
        `Duplicate command "${descriptor.name}" registered by feature "${featureId}". Command names must be unique.`,
      );
    }
    this.commandsByName.set(descriptor.name, descriptor);
  }

  registerComponent(descriptor: ComponentDescriptor, featureId: string): void {
    const key = componentKey(descriptor.scope, descriptor.action);
    if (this.componentsByKey.has(key)) {
      throw new Error(
        `Duplicate component "${key}" registered by feature "${featureId}". Scope and action must be unique together.`,
      );
    }
    this.componentsByKey.set(key, descriptor);
  }

  registerModal(descriptor: ModalDescriptor, featureId: string): void {
    const key = componentKey(descriptor.scope, descriptor.action);
    if (this.modalsByKey.has(key)) {
      throw new Error(`Duplicate modal "${key}" registered by feature "${featureId}".`);
    }
    this.modalsByKey.set(key, descriptor);
  }

  /** Events may have several subscribers; that is the one case without a collision. */
  registerEvent(descriptor: EventDescriptor, _featureId: string): void {
    const existing = this.eventsByName.get(descriptor.event) ?? [];
    existing.push(descriptor);
    this.eventsByName.set(descriptor.event, existing);
  }

  findCommand(name: string): CommandDescriptor | undefined {
    return this.commandsByName.get(name);
  }

  findComponent(scope: string, action: string): ComponentDescriptor | undefined {
    return this.componentsByKey.get(componentKey(scope, action));
  }

  findModal(scope: string, action: string): ModalDescriptor | undefined {
    return this.modalsByKey.get(componentKey(scope, action));
  }

  subscribersFor(event: EventName): readonly EventDescriptor[] {
    return this.eventsByName.get(event) ?? [];
  }

  /** Every command, for slash-command deployment. */
  commands(): readonly CommandDescriptor[] {
    return [...this.commandsByName.values()];
  }

  counts(): { commands: number; components: number; modals: number; events: number } {
    return {
      commands: this.commandsByName.size,
      components: this.componentsByKey.size,
      modals: this.modalsByKey.size,
      events: [...this.eventsByName.values()].reduce((sum, list) => sum + list.length, 0),
    };
  }
}
