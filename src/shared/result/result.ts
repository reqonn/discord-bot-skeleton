import type { AppError } from "../errors/app-error.js";

/**
 * The return type of every use case.
 *
 * Expected failures are values, not exceptions. A use case that can fail says so
 * in its signature, and a caller that ignores the failure branch does not
 * compile. `throw` is reserved for programmer error and genuinely exceptional
 * infrastructure failure — see docs/architecture.md, RULE 5.
 *
 * @example
 * const result = await closeTicket.execute(input);
 * if (!result.ok) return presentError(result.error);   // cannot be skipped
 * return presentClosed(result.value);
 */
export type Result<T, E = AppError> = Ok<T> | Err<E>;

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err<E> {
  readonly ok: false;
  readonly error: E;
}

export function ok(): Ok<void>;
export function ok<T>(value: T): Ok<T>;
export function ok<T>(value?: T): Ok<T | undefined> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Transforms the success value, leaving a failure untouched. */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Transforms the error, leaving a success untouched. */
export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

/** Chains a second fallible step, short-circuiting on the first failure. */
export function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/** Collapses to a plain value, substituting a fallback for any failure. */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
