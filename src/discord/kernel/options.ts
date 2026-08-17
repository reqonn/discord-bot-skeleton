import type { AutocompleteInteraction, ChatInputCommandInteraction } from "discord.js";

import type { OptionSpec } from "../contracts/command.contract.js";

/**
 * Reads declared options into a plain object, ready for validation.
 *
 * Entity options (user, channel, role) become their snowflake id rather than a
 * discord.js object. A use case that receives a `GuildMember` starts reaching
 * through it, and the containment boundary stops holding — an id is all the
 * domain ever legitimately needs.
 *
 * Options absent from the interaction are omitted rather than set to
 * undefined, so `exactOptionalPropertyTypes` and zod defaults both behave.
 */
export function readOptions(
  interaction: ChatInputCommandInteraction,
  specs: readonly OptionSpec[],
): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const spec of specs) {
    const value = readOption(interaction, spec);
    if (value !== null && value !== undefined) values[spec.name] = value;
  }

  return values;
}

function readOption(interaction: ChatInputCommandInteraction, spec: OptionSpec): unknown {
  switch (spec.type) {
    case "string":
      return interaction.options.getString(spec.name);
    case "integer":
      return interaction.options.getInteger(spec.name);
    case "number":
      return interaction.options.getNumber(spec.name);
    case "boolean":
      return interaction.options.getBoolean(spec.name);
    case "user":
      return interaction.options.getUser(spec.name)?.id;
    case "channel":
      return interaction.options.getChannel(spec.name)?.id;
    case "role":
      return interaction.options.getRole(spec.name)?.id;
  }
}

/**
 * The full command name, including subcommand path.
 *
 * Commands are registered under their spoken name — "ticket open" — because
 * that is what a user types and what appears in logs and metrics. Discord
 * models the same thing as a command plus a group plus a subcommand, so this
 * reassembles it.
 */
export function resolveCommandName(
  interaction: ChatInputCommandInteraction | AutocompleteInteraction,
): string {
  return [
    interaction.commandName,
    interaction.options.getSubcommandGroup(false),
    interaction.options.getSubcommand(false),
  ]
    .filter((part): part is string => part !== null && part !== undefined)
    .join(" ");
}
