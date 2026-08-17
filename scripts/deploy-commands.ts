import { createFeatures } from "#app/features.js";
import { buildInfrastructure } from "#app/wiring.js";

import { loadConfig } from "#platform/config/config.js";
import { createLogger } from "#platform/logging/pino.logger.js";
import { MetricsRegistry } from "#platform/metrics/metrics.registry.js";

import type { Messenger } from "#discord/contracts/messenger.contract.js";
import { deployCommands } from "#discord/kernel/command-deployer.js";
import { InteractionRegistry } from "#discord/kernel/registry.js";

import { isAppError } from "#shared/errors/app-error.js";

/**
 * Registers slash commands with Discord.
 *
 * Builds the *same* features the bot builds and reads the *same* registry the
 * pipeline dispatches from, so what is deployed and what is handled cannot
 * drift. A separate hand-maintained list of commands to deploy is how a bot
 * ends up advertising a command that no longer exists.
 */
/**
 * Deploying reads descriptors and never sends anything, so the messenger is
 * never called. A stub beats standing up a gateway client to satisfy a type.
 */
const NO_MESSENGER = {
  send: () => Promise.reject(new Error("deploy-commands does not send messages")),
  edit: () => Promise.reject(new Error("deploy-commands does not send messages")),
} as unknown as Messenger;

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const infrastructure = buildInfrastructure(config, logger, new MetricsRegistry());
  const registry = new InteractionRegistry();

  try {
    for (const feature of createFeatures(
      infrastructure,
      config.discord.prefix ?? "!",
      logger,
      NO_MESSENGER,
    )) {
      if (feature.devOnly === true && !config.profile.loadDevOnlyFeatures) continue;
      for (const command of feature.commands ?? []) registry.registerCommand(command, feature.id);
    }

    const guildScoped = config.profile.commandScope === "guild";
    if (guildScoped && config.discord.devGuildId === undefined) {
      console.error(
        "\nDISCORD_DEV_GUILD_ID is required to deploy guild-scoped commands.\n" +
          "Set it in .env, or set NODE_ENV=production to deploy globally.\n",
      );
      process.exit(1);
    }

    const result = await deployCommands(registry.commands(), {
      token: config.discord.token,
      clientId: config.discord.clientId,
      guildId: guildScoped ? config.discord.devGuildId : undefined,
    });

    console.log(`\nDeployed ${String(result.names.length)} command(s) — ${result.scope} scope.`);
    for (const name of result.names) console.log(`  /${name}`);
    console.log(
      result.scope === "guild"
        ? "\nGuild commands appear immediately.\n"
        : "\nGlobal commands can take up to an hour to appear everywhere.\n",
    );
  } finally {
    await infrastructure.stop();
  }
}

main().catch((error: unknown) => {
  console.error(`\n${isAppError(error) ? (error.detail ?? error.message) : String(error)}\n`);
  process.exit(1);
});
