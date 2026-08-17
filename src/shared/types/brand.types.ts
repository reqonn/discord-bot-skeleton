/**
 * Nominal ("branded") types.
 *
 * TypeScript is structurally typed, so a `string` holding a user id and a
 * `string` holding a channel id are the same type — and swapping two arguments
 * at a call site compiles cleanly. Branding makes them distinct at compile time
 * with zero runtime cost.
 *
 * @example
 * type UserId = Brand<string, "UserId">;
 * const id = "123" as UserId;      // explicit cast at the boundary
 * takesChannelId(id);              // compile error, as intended
 */
export type Brand<T, TBrand extends string> = T & { readonly __brand: TBrand };

/** Recursively marks every property readonly. Useful for frozen config trees. */
export type DeepReadonly<T> = T extends (infer R)[]
  ? readonly DeepReadonly<R>[]
  : T extends (...args: never[]) => unknown
    ? T
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** A plain JSON-serialisable value. Used for log fields and job payloads. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
