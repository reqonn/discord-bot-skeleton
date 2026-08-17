import {
  ApplicationCommandOptionType,
  type APIApplicationCommandBasicOption,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";

import type { CommandDescriptor, OptionSpec } from "../contracts/command.contract.js";

const OPTION_TYPES = {
  string: ApplicationCommandOptionType.String,
  integer: ApplicationCommandOptionType.Integer,
  number: ApplicationCommandOptionType.Number,
  boolean: ApplicationCommandOptionType.Boolean,
  user: ApplicationCommandOptionType.User,
  channel: ApplicationCommandOptionType.Channel,
  role: ApplicationCommandOptionType.Role,
} as const;

/**
 * Turns registered commands into the payload Discord expects.
 *
 * Descriptors are flat — "ticket", "ticket open", "ticket close" — because that
 * is how they are invoked, logged, and reasoned about. Discord instead wants a
 * tree of commands containing subcommand groups containing subcommands, so this
 * regroups by the first word.
 *
 * Building the payload from the same registry the pipeline dispatches from is
 * what stops deployment and runtime drifting apart: a command that is
 * registered is deployed, and one that is not, is not.
 */
export function buildCommandPayload(
  commands: readonly CommandDescriptor[],
): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  const roots = new Map<string, RESTPostAPIChatInputApplicationCommandsJSONBody>();

  // Shallowest first, so a root's own descriptor is seen before its children
  // and its description is the authored one rather than a placeholder.
  const ordered = [...commands].sort((a, b) => a.name.split(" ").length - b.name.split(" ").length);

  for (const command of ordered) {
    const [rootName = "", ...rest] = command.name.split(" ");

    const root = roots.get(rootName) ?? {
      name: rootName,
      // Replaced below if a descriptor for the bare root exists.
      description: `${rootName} commands`,
      options: [],
    };
    roots.set(rootName, root);

    if (rest.length === 0) {
      root.description = command.description;
      root.options = [...(root.options ?? []), ...command.options.map(toApiOption)];
      continue;
    }

    if (rest.length === 1) {
      root.options = [
        ...(root.options ?? []),
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: rest[0] ?? "",
          description: command.description,
          options: command.options.map(toApiOption),
        },
      ];
      continue;
    }

    const [groupName = "", subcommandName = ""] = rest;
    const options = root.options ?? [];
    let group = options.find(
      (option) =>
        option.type === ApplicationCommandOptionType.SubcommandGroup && option.name === groupName,
    );

    if (group === undefined) {
      group = {
        type: ApplicationCommandOptionType.SubcommandGroup,
        name: groupName,
        description: `${groupName} commands`,
        options: [],
      };
      options.push(group);
      root.options = options;
    }

    if (group.type === ApplicationCommandOptionType.SubcommandGroup) {
      group.options = [
        ...(group.options ?? []),
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: subcommandName,
          description: command.description,
          options: command.options.map(toApiOption),
        },
      ];
    }
  }

  return [...roots.values()];
}

function toApiOption(spec: OptionSpec): APIApplicationCommandBasicOption {
  const base = {
    name: spec.name,
    description: spec.description,
    required: spec.required ?? false,
  };

  switch (spec.type) {
    case "string":
      return {
        ...base,
        type: OPTION_TYPES.string,
        ...(spec.minLength !== undefined ? { min_length: spec.minLength } : {}),
        ...(spec.maxLength !== undefined ? { max_length: spec.maxLength } : {}),
        ...(spec.choices !== undefined
          ? { choices: spec.choices.map((c) => ({ name: c.name, value: String(c.value) })) }
          : {}),
        ...(spec.autocomplete === true ? { autocomplete: true } : {}),
        // The API type models autocomplete and choices as mutually exclusive
        // variants; the spec already guarantees only one is set.
      } as APIApplicationCommandBasicOption;

    case "integer":
    case "number":
      return {
        ...base,
        type: OPTION_TYPES[spec.type],
        ...(spec.min !== undefined ? { min_value: spec.min } : {}),
        ...(spec.max !== undefined ? { max_value: spec.max } : {}),
        ...(spec.choices !== undefined
          ? { choices: spec.choices.map((c) => ({ name: c.name, value: Number(c.value) })) }
          : {}),
        ...(spec.autocomplete === true ? { autocomplete: true } : {}),
      } as APIApplicationCommandBasicOption;

    default:
      return { ...base, type: OPTION_TYPES[spec.type] };
  }
}
