import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, type Config } from "#platform/config/config.js";
import { Metric } from "#platform/metrics/metrics.catalog.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";
import { OpsServer } from "#platform/ops/ops.server.js";
import type { ReadinessProbe } from "#platform/ops/readiness.contract.js";

import { MemoryLogger } from "#testing/memory.logger.js";

const BASE_ENV = {
  DISCORD_TOKEN: "token",
  DISCORD_CLIENT_ID: "1",
  DATABASE_URL: "postgres://localhost/bot",
  // Port 0 asks the OS for a free one, so tests never collide.
  OPS_PORT: "0",
} as const;

function probe(name: string, ready: boolean, detail?: string): ReadinessProbe {
  return {
    name,
    probe: () => Promise.resolve(detail === undefined ? { ready } : { ready, detail }),
  };
}

let running: OpsServer | undefined;

async function startServer(options: {
  config?: Config;
  probes?: readonly ReadinessProbe[];
  metrics?: MetricsRegistry;
  booted?: boolean;
}): Promise<{ server: OpsServer; url: string }> {
  const config = options.config ?? loadConfig({ ...BASE_ENV });
  const server = new OpsServer({
    config,
    logger: new MemoryLogger(),
    metrics: options.metrics ?? new MetricsRegistry(),
    probes: options.probes ?? [],
  });

  await server.start();
  if (options.booted !== false) server.markBooted();
  running = server;

  return { server, url: `http://127.0.0.1:${String(server.port)}` };
}

afterEach(async () => {
  await running?.stop();
  running = undefined;
});

describe("OpsServer", () => {
  describe("/healthz", () => {
    it("reports alive without consulting any dependency", async () => {
      let probed = false;
      const { url } = await startServer({
        probes: [
          {
            name: "database",
            probe: () => {
              probed = true;
              return Promise.resolve({ ready: true });
            },
          },
        ],
      });

      const response = await fetch(`${url}/healthz`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "alive" });
      // A liveness check that touches the database restarts healthy processes
      // during a database blip. It must stay cheap.
      expect(probed).toBe(false);
    });
  });

  describe("/readyz", () => {
    it("reports starting until boot completes", async () => {
      const { url } = await startServer({ booted: false });

      const response = await fetch(`${url}/readyz`);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ status: "starting" });
    });

    it("reports ready when every probe passes", async () => {
      const { url } = await startServer({
        probes: [probe("database", true), probe("discord", true)],
      });

      const response = await fetch(`${url}/readyz`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: "ready",
        checks: { database: { ready: true }, discord: { ready: true } },
      });
    });

    it("returns 503 and names the failing dependency", async () => {
      const { url } = await startServer({
        probes: [probe("database", false, "connection refused"), probe("discord", true)],
      });

      const response = await fetch(`${url}/readyz`);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        status: "degraded",
        checks: {
          database: { ready: false, detail: "connection refused" },
          discord: { ready: true },
        },
      });
    });

    it("treats a throwing probe as not ready rather than a 500", async () => {
      const { url } = await startServer({
        probes: [{ name: "database", probe: () => Promise.reject(new Error("boom")) }],
      });

      const response = await fetch(`${url}/readyz`);

      expect(response.status).toBe(503);
      expect(await response.text()).toContain("boom");
    });

    it("omits a probe that was never registered", async () => {
      // Development wires no Redis at all, so readiness has nothing to say
      // about it — better than a probe reporting "disabled".
      const { url } = await startServer({ probes: [probe("database", true)] });

      const body = (await (await fetch(`${url}/readyz`)).json()) as { checks: object };

      expect(Object.keys(body.checks)).toEqual(["database"]);
    });
  });

  describe("/metrics", () => {
    it("is not served at all in production without a token", async () => {
      // OPS_METRICS_TOKEN is optional so a simple deployment is not blocked by
      // it. That must not turn into "leave it unset and publish your traffic
      // statistics to anyone who finds the port" — unset means off, not open.
      const config = loadConfig({
        ...BASE_ENV,
        NODE_ENV: "production",
        OPS_METRICS_TOKEN: undefined,
      });
      const metrics = new MetricsRegistry();
      metrics.increment(Metric.commandTotal, { command: "ping", outcome: "ok" });

      const { url } = await startServer({ config, metrics });
      const response = await fetch(`${url}/metrics`);

      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("bot_command_total");
    });

    it("is served in production once a token is set", async () => {
      const config = loadConfig({
        ...BASE_ENV,
        NODE_ENV: "production",
        OPS_METRICS_TOKEN: "secret",
      });

      const { url } = await startServer({ config });
      const response = await fetch(`${url}/metrics`, {
        headers: { authorization: "Bearer secret" },
      });

      expect(response.status).toBe(200);
    });

    it("is open when no token is configured", async () => {
      const metrics = new MetricsRegistry();
      metrics.increment(Metric.commandTotal, { command: "ping", outcome: "ok" });

      const { url } = await startServer({ metrics });
      const response = await fetch(`${url}/metrics`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toContain('bot_command_total{command="ping",outcome="ok"} 1');
    });

    it("rejects a request with no token when one is configured", async () => {
      const config = loadConfig({ ...BASE_ENV, OPS_METRICS_TOKEN: "secret" });
      const { url } = await startServer({ config });

      expect((await fetch(`${url}/metrics`)).status).toBe(401);
    });

    it("rejects a wrong token", async () => {
      const config = loadConfig({ ...BASE_ENV, OPS_METRICS_TOKEN: "secret" });
      const { url } = await startServer({ config });

      const response = await fetch(`${url}/metrics`, {
        headers: { authorization: "Bearer wrong" },
      });

      expect(response.status).toBe(401);
    });

    it("rejects a token of a different length without throwing", async () => {
      // timingSafeEqual throws on unequal buffer lengths; hashing both sides
      // first is what keeps this a 401 rather than a 500.
      const config = loadConfig({ ...BASE_ENV, OPS_METRICS_TOKEN: "secret" });
      const { url } = await startServer({ config });

      const response = await fetch(`${url}/metrics`, {
        headers: { authorization: "Bearer x" },
      });

      expect(response.status).toBe(401);
    });

    it("accepts the correct token", async () => {
      const config = loadConfig({ ...BASE_ENV, OPS_METRICS_TOKEN: "secret" });
      const { url } = await startServer({ config });

      const response = await fetch(`${url}/metrics`, {
        headers: { authorization: "Bearer secret" },
      });

      expect(response.status).toBe(200);
    });
  });

  it("404s an unknown path", async () => {
    const { url } = await startServer({});

    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });

  it("stops cleanly and stops accepting connections", async () => {
    const { server, url } = await startServer({});
    await server.stop();
    running = undefined;

    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
  });
});
