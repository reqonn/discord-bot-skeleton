import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Config } from "../config/config.js";
import type { Logger } from "../logging/logger.contract.js";
import type { Metrics } from "../metrics/metrics.contract.js";

import type { ProbeResult, ReadinessProbe } from "./readiness.contract.js";

/** A probe that hangs must not hang the readiness endpoint. */
const PROBE_TIMEOUT_MS = 2_000;

export interface OpsServerDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly probes: readonly ReadinessProbe[];
}

/**
 * Serves the three operational endpoints.
 *
 *   /healthz  — is the process alive? Touches nothing. A load balancer polling
 *               this must never be the reason the database sees traffic.
 *   /readyz   — should this process receive work? Runs every registered probe.
 *   /metrics  — Prometheus exposition, bearer-guarded.
 *
 * The split matters: a liveness check that touches the database restarts a
 * healthy process during a database blip, turning a partial outage into a
 * total one.
 */
export class OpsServer {
  private server: Server | undefined;
  /** Flipped once boot finishes, so /readyz reports honestly while starting up. */
  private booted = false;

  constructor(private readonly deps: OpsServerDeps) {}

  markBooted(): void {
    this.booted = true;
  }

  /**
   * The port actually bound, which differs from the configured one when
   * OPS_PORT is 0. Undefined before `start()`.
   */
  get port(): number | undefined {
    const address = this.server?.address();
    return address !== null && typeof address === "object" ? address.port : undefined;
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        this.deps.logger.error("Ops request failed", { error, url: request.url });
        if (!response.headersSent) response.writeHead(500).end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.deps.config.ops.port, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    this.server = server;
    this.deps.logger.info("Ops server listening", { port: this.deps.config.ops.port });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      // Keep-alive sockets would otherwise hold the close open past our
      // shutdown budget.
      server.closeIdleConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "/").split("?")[0];

    switch (path) {
      case "/healthz":
        return sendJson(response, 200, { status: "alive" });

      case "/readyz":
        return this.handleReadyz(response);

      case "/metrics":
        return this.handleMetrics(request, response);

      default:
        return sendJson(response, 404, { error: "not found" });
    }
  }

  private async handleReadyz(response: ServerResponse): Promise<void> {
    if (!this.booted) {
      return sendJson(response, 503, { status: "starting" });
    }

    const results = await Promise.all(
      this.deps.probes.map(async (probe) => ({
        name: probe.name,
        result: await withTimeout(probe),
      })),
    );

    const checks = Object.fromEntries(
      results.map(({ name, result }) => [
        name,
        result.detail === undefined
          ? { ready: result.ready }
          : { ready: result.ready, detail: result.detail },
      ]),
    );

    const ready = results.every(({ result }) => result.ready);
    return sendJson(response, ready ? 200 : 503, { status: ready ? "ready" : "degraded", checks });
  }

  private handleMetrics(request: IncomingMessage, response: ServerResponse): void {
    const { metricsToken } = this.deps.config.ops;

    if (metricsToken === undefined) {
      // No token. In development that means open, which is convenient and
      // local. In production it means *off* — serving traffic statistics to
      // anyone who finds the port is not an acceptable consequence of leaving
      // an optional variable unset. Set OPS_METRICS_TOKEN to enable it.
      if (!this.deps.config.profile.allowUnguardedMetrics) {
        return sendJson(response, 404, { error: "not found" });
      }
    } else if (!hasValidToken(request, metricsToken)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const body = this.deps.metrics.render();
    response.writeHead(200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  }
}

async function withTimeout(probe: ReadinessProbe): Promise<ProbeResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe.probe(),
      new Promise<ProbeResult>((resolve) => {
        timer = setTimeout(() => {
          resolve({ ready: false, detail: `probe timed out after ${PROBE_TIMEOUT_MS}ms` });
        }, PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // A probe that throws is a probe that failed; readiness must never 500.
    return { ready: false, detail: error instanceof Error ? error.message : "probe threw" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Compares the bearer token in constant time.
 *
 * Both sides are hashed first so the comparison operates on equal-length
 * buffers — `timingSafeEqual` throws on a length mismatch, and using raw
 * lengths would leak the token's length through that error.
 */
function hasValidToken(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return false;

  const provided = createHash("sha256").update(header.slice("Bearer ".length)).digest();
  const known = createHash("sha256").update(expected).digest();
  return timingSafeEqual(provided, known);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
