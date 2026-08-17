import type { Brand } from "./brand.types.js";

/**
 * A Discord snowflake id.
 *
 * Branded so a guild id cannot be passed where a channel id is expected. Note
 * that this is deliberately *not* further split into GuildId / ChannelId /
 * UserId brands: the extra precision costs casts at every boundary and the
 * argument-order mistakes it would catch are already caught by named parameter
 * objects, which is the convention for anything taking more than two ids.
 */
export type Snowflake = Brand<string, "Snowflake">;

/** Discord snowflakes are 17–20 digit decimal strings. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export function isSnowflake(value: unknown): value is Snowflake {
  return typeof value === "string" && SNOWFLAKE_PATTERN.test(value);
}

/**
 * Asserts at a trust boundary that a string really is a snowflake.
 * Use when accepting ids from user input or an external system — never to
 * launder a value we already produced.
 */
export function toSnowflake(value: string): Snowflake {
  if (!SNOWFLAKE_PATTERN.test(value)) {
    throw new TypeError(`Not a Discord snowflake: ${JSON.stringify(value)}`);
  }
  return value as Snowflake;
}

/**
 * Trusted cast, for values that came from discord.js or our own database and
 * are snowflakes by construction. Separate from `toSnowflake` so the unchecked
 * path is visible in review rather than hidden behind the validating one.
 */
export function asSnowflake(value: string): Snowflake {
  return value as Snowflake;
}
