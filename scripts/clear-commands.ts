import { loadConfig } from "#platform/config/config.js";

import { clearCommands } from "#discord/kernel/command-deployer.js";

import { isAppError } from "#shared/errors/app-error.js";

/**
 * Removes every registered slash command.
 *
 * For when a rename leaves an orphan, or a development guild accumulates
 * commands from an old branch. Clears the same scope the current profile
 * deploys to, so it cannot wipe production from a development shell.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const guildScoped = config.profile.commandScope === "guild";

  if (guildScoped && config.discord.devGuildId === undefined) {
    console.error("\nDISCORD_DEV_GUILD_ID is required to clear guild-scoped commands.\n");
    process.exit(1);
  }

  await clearCommands({
    token: config.discord.token,
    clientId: config.discord.clientId,
    guildId: guildScoped ? config.discord.devGuildId : undefined,
  });

  console.log(
    guildScoped
      ? `\nCleared all commands in guild ${config.discord.devGuildId ?? ""}.\n`
      : "\nCleared all global commands.\n",
  );
}

main().catch((error: unknown) => {
  console.error(`\n${isAppError(error) ? (error.detail ?? error.message) : String(error)}\n`);
  process.exit(1);
});
