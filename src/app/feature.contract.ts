import type { Job } from "#platform/jobs/job.contract.js";
import type { ReadinessProbe } from "#platform/ops/readiness.contract.js";

import type { CommandDescriptor } from "#discord/contracts/command.contract.js";
import type {
  ComponentDescriptor,
  ModalDescriptor,
} from "#discord/contracts/component.contract.js";
import type { EventDescriptor } from "#discord/contracts/event.contract.js";

/**
 * Everything a feature contributes to the running process.
 *
 * A feature is assembled by a factory that takes exactly the dependencies it
 * needs — `createHealthFeature({ database, cache })` — rather than reaching
 * into a shared container. Two consequences worth the small extra typing:
 *
 *   - a feature's dependencies are readable from its signature, so "what does
 *     tickets actually touch?" is answered without reading its source
 *   - a test constructs a feature with fakes and nothing else
 *
 * Registration is explicit in src/app/features.ts — one line per feature, no
 * filesystem scanning. Convention-based discovery reads as magic until the day
 * a file is named slightly wrong and silently never loads.
 */
export interface Feature {
  /** Kebab-case, matching the directory name. */
  readonly id: string;

  /**
   * Loaded only outside production. For scaffolding and diagnostics that
   * should never reach a real server.
   */
  readonly devOnly?: boolean;

  readonly commands?: readonly CommandDescriptor[];
  readonly components?: readonly ComponentDescriptor[];
  readonly modals?: readonly ModalDescriptor[];
  readonly events?: readonly EventDescriptor[];
  readonly jobs?: readonly Job[];

  /** Contributions to /readyz. A feature that owns a dependency reports on it. */
  readonly readiness?: readonly ReadinessProbe[];
}

export function defineFeature(feature: Feature): Feature {
  return feature;
}
