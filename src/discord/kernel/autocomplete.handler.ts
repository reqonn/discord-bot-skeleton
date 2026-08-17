import type { AutocompleteInteraction } from "discord.js";

import type { Logger } from "../../platform/logging/logger.contract.js";
import { asSnowflake } from "../../shared/types/snowflake.types.js";
import type { Actor } from "../contracts/actor.contract.js";

import { resolveCommandName } from "./options.js";
import type { InteractionRegistry } from "./registry.js";

/** Discord rejects an autocomplete response with more than this many choices. */
const MAX_CHOICES = 25;

/**
 * Serves autocomplete.
 *
 * Handled apart from the main pipeline because it shares almost none of it:
 * there is no deferral (Discord gives no acknowledgement window), no cooldown
 * (typing is not an action), no rendering, and no way to show an error. The
 * only thing a user can be shown is a list of choices, so the failure mode is
 * an empty list — which is why this fails quietly and logs, rather than
 * surfacing anything.
 */
export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  registry: InteractionRegistry,
  logger: Logger,
): Promise<void> {
  const name = resolveCommandName(interaction);
  const command = registry.findCommand(name);

  if (command?.autocomplete === undefined) {
    await interaction.respond([]);
    return;
  }

  try {
    const focused = interaction.options.getFocused(true);
    const choices = await command.autocomplete({
      correlationId: "autocomplete",
      actor: minimalActor(interaction),
      guild:
        interaction.guild === null
          ? null
          : { id: asSnowflake(interaction.guild.id), name: interaction.guild.name },
      focused: { name: focused.name, value: focused.value },
    });

    await interaction.respond([...choices.slice(0, MAX_CHOICES)]);
  } catch (error) {
    logger.warn("Autocomplete failed", { error, command: name });
    if (!interaction.responded) await interaction.respond([]);
  }
}

/**
 * Autocomplete carries no member context worth materialising.
 *
 * Resolving permissions here would cost work on the most latency-sensitive
 * interaction there is, for a suggestion list. An autocomplete handler that
 * needs authorization is a sign the data should not be suggested at all.
 */
function minimalActor(interaction: AutocompleteInteraction): Actor {
  return {
    userId: asSnowflake(interaction.user.id),
    displayName: interaction.user.displayName,
    isBot: interaction.user.bot,
    roleIds: [],
    permissions: new Set(),
    isGuildOwner: false,
  };
}
