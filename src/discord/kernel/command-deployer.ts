import { REST, Routes } from "discord.js";

import type { CommandDescriptor } from "../contracts/command.contract.js";

import { buildCommandPayload } from "./command-builder.js";

export interface DeployTarget {
  readonly token: string;
  readonly clientId: string;
  /**
   * Guild to deploy to, or undefined for a global deployment.
   * Guild commands appear immediately; global commands are cached by Discord
   * for up to an hour, which is why development uses a guild.
   */
  readonly guildId: string | undefined;
}

export interface DeployResult {
  readonly scope: "guild" | "global";
  readonly names: readonly string[];
}

/**
 * Publishes commands to Discord.
 *
 * Lives here rather than in the script because RULE 1 has no exceptions: if
 * `scripts/` were allowed to import discord.js, the rule would become "mostly",
 * and a rule that is mostly true is one people stop checking. The script
 * supplies configuration and prints output; the Discord call is the kernel's.
 */
export async function deployCommands(
  commands: readonly CommandDescriptor[],
  target: DeployTarget,
): Promise<DeployResult> {
  const payload = buildCommandPayload(commands);
  const rest = new REST().setToken(target.token);

  const route =
    target.guildId === undefined
      ? Routes.applicationCommands(target.clientId)
      : Routes.applicationGuildCommands(target.clientId, target.guildId);

  await rest.put(route, { body: payload });

  return {
    scope: target.guildId === undefined ? "global" : "guild",
    names: payload.map((command) => command.name),
  };
}

/** Removes every command in the target scope. */
export async function clearCommands(target: DeployTarget): Promise<void> {
  const rest = new REST().setToken(target.token);

  const route =
    target.guildId === undefined
      ? Routes.applicationCommands(target.clientId)
      : Routes.applicationGuildCommands(target.clientId, target.guildId);

  await rest.put(route, { body: [] });
}
