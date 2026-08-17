import { resolve } from "node:path";

import { loadConfig, type Config } from "#platform/config/config.js";
import { Migrator } from "#platform/database/migrator.js";
import { JobScheduler } from "#platform/jobs/job.scheduler.js";
import { ShutdownSequence } from "#platform/lifecycle/shutdown.sequence.js";
import type { Logger } from "#platform/logging/logger.contract.js";
import { createLogger } from "#platform/logging/pino.logger.js";
import { EventLoopMonitor } from "#platform/metrics/event-loop.monitor.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";
import { OpsServer } from "#platform/ops/ops.server.js";
import type { ReadinessProbe } from "#platform/ops/readiness.contract.js";

import { DiscordMessenger } from "#discord/gateway/discord.messenger.js";
import { OutboundLimiter } from "#discord/gateway/outbound.limiter.js";
import { createClient } from "#discord/kernel/client.js";
import { attachGateway, loginAndAwaitReady } from "#discord/kernel/lifecycle.js";
import { InteractionPipeline } from "#discord/kernel/pipeline.js";
import { InteractionRegistry } from "#discord/kernel/registry.js";

import { createGuildPrefixResolver } from "#features/guild/prefix/feature.js";

import { createFeatures } from "./features.js";
import { buildInfrastructure } from "./wiring.js";

const MIGRATIONS_DIR = resolve(process.cwd(), "database", "migrations");

/** How often pool gauges are refreshed. Matches the event-loop sampler. */
const POOL_METRICS_INTERVAL_MS = 10_000;

export interface Application {
  readonly config: Config;
  readonly logger: Logger;
  shutdown(reason: string): Promise<boolean>;
}

/**
 * Builds and starts the process.
 *
 * The only place startup order is decided, stated explicitly rather than
 * emerging from import side effects. The order is load-bearing:
 *
 *   1. configuration — an invalid environment must fail before anything opens
 *      a socket
 *   2. observability — so every later step is visible if it fails
 *   3. the ops server — so an orchestrator sees liveness during a slow boot
 *   4. infrastructure, then migrations — the schema must be current before any
 *      feature is constructed against it
 *   5. features into the registry — collisions fail here, at boot, not later
 *   6. the gateway — last, because accepting interactions before the above is
 *      ready means answering them wrongly
 *
 * Teardown is registered beside each step and runs in reverse, so the two
 * halves cannot drift apart.
 */
export async function startApplication(): Promise<Application> {
  const config = loadConfig();
  const logger = createLogger(config);
  const shutdown = new ShutdownSequence(logger, config.shutdownTimeoutMs);

  logger.info("Starting", {
    // `env` is already a base binding on every line — repeating it here emits
    // the key twice, which some log processors keep and others silently drop.
    logLevel: config.logLevel,
    prefix: config.discord.prefix ?? "(message commands off)",
    commandScope: config.profile.commandScope,
    node: process.version,
  });

  try {
    return await start(config, logger, shutdown);
  } catch (error) {
    // A failed boot must still release what it managed to acquire. Without
    // this the ops port stays bound and the pool stays open while the process
    // exits, which on some platforms takes the runtime down with an assertion
    // instead of a readable error.
    await shutdown.run("startup-failed");
    throw error;
  }
}

async function start(
  config: Config,
  logger: Logger,
  shutdown: ShutdownSequence,
): Promise<Application> {
  const metrics = new MetricsRegistry();
  const eventLoop = new EventLoopMonitor(metrics, logger);
  eventLoop.start();
  shutdown.add("event-loop-monitor", () => {
    eventLoop.stop();
  });

  const probes: ReadinessProbe[] = [];
  const ops = new OpsServer({ config, logger, metrics, probes });
  await ops.start();
  shutdown.add("ops-server", () => ops.stop());

  // ── Infrastructure ─────────────────────────────────────────────────────────
  const infrastructure = buildInfrastructure(config, logger, metrics);
  shutdown.add("infrastructure", () => infrastructure.stop());

  // Before anything uses the cache. The Redis client disables its offline
  // queue so a hot-path read fails instead of waiting, which makes connecting
  // up front a correctness requirement rather than an optimisation.
  await infrastructure.start();

  await new Migrator(infrastructure.database, logger, MIGRATIONS_DIR).up();
  await infrastructure.database.warmUp();

  // Pool state is a gauge, so something has to publish it. Sustained `waiting`
  // above zero is the signal that the pool is too small — worth seeing before
  // it shows up as commands timing out.
  const poolMetrics = setInterval(() => {
    infrastructure.database.publishPoolMetrics();
  }, POOL_METRICS_INTERVAL_MS);
  poolMetrics.unref();
  infrastructure.database.publishPoolMetrics();
  shutdown.add("pool-metrics", () => {
    clearInterval(poolMetrics);
  });

  probes.push({
    name: "database",
    probe: async () => {
      await infrastructure.database.query("SELECT 1");
      return { ready: true };
    },
  });

  // ── Outbound ───────────────────────────────────────────────────────────────
  // Governs everything the bot says without being asked: per-guild budget,
  // per-guild-and-feature circuit breaker, priority queue. Interaction replies
  // deliberately bypass it — they answer someone who is waiting, and delaying
  // one to protect a background send would be exactly backwards.
  //
  // Built before the features, because a feature takes the messenger as a
  // dependency. The client is *created* here and does not connect until
  // `loginAndAwaitReady` below, so the "gateway last" ordering still holds:
  // nothing accepts an interaction until everything else is ready.
  const outbound = new OutboundLimiter(logger, metrics);
  outbound.start();
  shutdown.add("outbound-limiter", () => {
    outbound.stop();
  });

  // The client is created *after* the features, because its intents are
  // derived from what they subscribed to — so the messenger is handed a
  // provider rather than an instance. Nothing sends before login, and this is
  // the cycle broken at its only honest seam.
  // A holder rather than a bare `let`, because the messenger closes over it
  // before it is filled and the mutation is the point. Typed from the factory
  // rather than by importing discord.js, which RULE 1 forbids here as firmly as
  // it does in a feature.
  const gateway: { client: ReturnType<typeof createClient> | undefined } = { client: undefined };
  const messenger = new DiscordMessenger(
    () => gateway.client,
    outbound,
    logger,
    config.profile.showErrorDetail,
  );

  // ── Features ───────────────────────────────────────────────────────────────
  const registry = new InteractionRegistry();
  const scheduler = new JobScheduler(logger, metrics, infrastructure.lock);

  for (const feature of createFeatures(
    infrastructure,
    config.discord.prefix ?? "!",
    logger,
    messenger,
  )) {
    if (feature.devOnly === true && !config.profile.loadDevOnlyFeatures) continue;

    for (const command of feature.commands ?? []) registry.registerCommand(command, feature.id);
    for (const component of feature.components ?? []) {
      registry.registerComponent(component, feature.id);
    }
    for (const modal of feature.modals ?? []) registry.registerModal(modal, feature.id);
    for (const event of feature.events ?? []) registry.registerEvent(event, feature.id);
    for (const job of feature.jobs ?? []) scheduler.register(job);
    probes.push(...(feature.readiness ?? []));
  }

  logger.info("Features registered", registry.counts());

  // ── Gateway ────────────────────────────────────────────────────────────────
  // Privileged intents are requested only when something actually needs them,
  // rather than configured by hand: message commands imply Message Content, and
  // a feature subscribing to member joins implies Server Members. Asking for an
  // intent the application has not been granted makes Discord refuse the login,
  // so "nobody uses it" and "do not ask for it" must be the same decision.
  const client = createClient({
    messageCommands: config.discord.prefix !== undefined,
    memberEvents: registry.subscribersFor("memberJoined").length > 0,
  });
  gateway.client = client;

  const pipeline = new InteractionPipeline({
    registry,
    logger,
    metrics,
    cooldowns: infrastructure.cooldowns,
    profile: config.profile,
    prefix: config.discord.prefix,
    // Built here rather than imported by the kernel, which must not depend on
    // a feature. Delete guild/prefix and this line goes with it; the pipeline
    // falls back to the configured prefix and nothing else changes.
    guildPrefix: createGuildPrefixResolver({
      database: infrastructure.database,
      cache: infrastructure.cache,
    }),
  });

  attachGateway(client, pipeline, registry, logger);
  shutdown.add("discord-client", async () => {
    await client.destroy();
  });

  await loginAndAwaitReady(client, config.discord.token, config.discord.readyTimeoutMs);

  probes.push({
    name: "discord",
    probe: () => Promise.resolve({ ready: client.isReady() }),
  });

  // Jobs start last: they run against a fully wired process, and only once the
  // gateway is ready is that true.
  scheduler.start();
  shutdown.add("jobs", () => {
    scheduler.stop();
  });

  ops.markBooted();
  logger.info("Started", {
    user: client.user?.tag,
    guilds: client.guilds.cache.size,
    opsPort: ops.port,
  });

  return { config, logger, shutdown: (reason) => shutdown.run(reason) };
}
