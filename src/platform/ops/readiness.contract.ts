export interface ProbeResult {
  readonly ready: boolean;
  /** Short, operator-facing explanation. Must not contain credentials. */
  readonly detail?: string | undefined;
}

/**
 * One dependency's contribution to readiness.
 *
 * Registered by the composition root, so /readyz reflects what this process
 * actually wired: with Redis absent in development there is simply no Redis
 * probe, rather than a probe that reports "disabled" and has to be interpreted.
 */
export interface ReadinessProbe {
  readonly name: string;
  probe(): Promise<ProbeResult>;
}
