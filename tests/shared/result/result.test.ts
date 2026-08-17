import { describe, expect, it } from "vitest";

import { NotFoundError } from "#shared/errors/app-error.js";
import { andThen, err, isErr, isOk, map, mapErr, ok, unwrapOr } from "#shared/result/result.js";

describe("Result", () => {
  it("carries a success value", () => {
    const result = ok(42);
    expect(result.ok).toBe(true);
    expect(isOk(result)).toBe(true);
    if (result.ok) expect(result.value).toBe(42);
  });

  it("supports a void success", () => {
    expect(ok().value).toBeUndefined();
  });

  it("carries a failure", () => {
    const error = new NotFoundError("No such ticket.");
    const result = err(error);
    expect(isErr(result)).toBe(true);
    if (!result.ok) expect(result.error).toBe(error);
  });

  it("maps only the success branch", () => {
    expect(map(ok(2), (n) => n * 3)).toEqual({ ok: true, value: 6 });

    const failure = err(new NotFoundError("gone"));
    expect(map(failure, () => "unreachable")).toBe(failure);
  });

  it("maps only the failure branch", () => {
    const success = ok(1);
    expect(mapErr(success, () => "unreachable")).toBe(success);
    expect(mapErr(err("boom"), (e) => `${e}!`)).toEqual({ ok: false, error: "boom!" });
  });

  it("short-circuits a chain on the first failure", () => {
    const failure = err("first");
    let secondRan = false;

    const result = andThen(failure, () => {
      secondRan = true;
      return ok("unreachable");
    });

    expect(secondRan).toBe(false);
    expect(result).toBe(failure);
  });

  it("substitutes a fallback for a failure", () => {
    expect(unwrapOr(ok("value"), "fallback")).toBe("value");
    expect(unwrapOr(err("boom"), "fallback")).toBe("fallback");
  });
});
