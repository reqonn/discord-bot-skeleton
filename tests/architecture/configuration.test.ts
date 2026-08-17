import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { describeEnvVar, envSchema } from "#platform/config/config.schema.js";

/**
 * The schema and `.env.example`, checked against each other.
 *
 * These two drift silently and in both directions. A variable added to the
 * schema but not the example is one a new contributor never learns exists,
 * until their bot refuses to boot and names something they have never seen. A
 * variable left in the example after the schema drops it is worse: it looks
 * configurable, is copied forward for years, and does nothing.
 *
 * `AGENTS.md` asks agents to update both. This is what makes that instruction
 * true rather than hopeful — and it is exactly the check that was being run by
 * hand, which is the usual sign something belongs in the suite.
 */

const ROOT = process.cwd();

/**
 * Variables the schema reads but the example deliberately omits.
 *
 * `PORT` is injected by the host (Railway, Render, Fly). Listing it would
 * invite someone to set it locally and then wonder why their deployment
 * ignores the value.
 */
const HOST_INJECTED = new Set(["PORT"]);

const example = await readFile(join(ROOT, ".env.example"), "utf8");

const schemaKeys = Object.keys(envSchema.shape);
const exampleKeys = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1] ?? "");

describe("configuration", () => {
  it("has a schema to check", () => {
    // Guards the guard: an empty shape would make everything below vacuous.
    expect(schemaKeys.length).toBeGreaterThan(10);
    expect(exampleKeys.length).toBeGreaterThan(10);
  });

  it("documents every variable the schema reads", () => {
    const undocumented = schemaKeys
      .filter((key) => !HOST_INJECTED.has(key))
      .filter((key) => !exampleKeys.includes(key));

    expect(undocumented).toEqual([]);
  });

  it("declares every variable the example offers", () => {
    // The other direction. A key here that the schema does not know is a
    // setting someone can carefully fill in for no effect whatsoever.
    const unknown = exampleKeys.filter((key) => !schemaKeys.includes(key));

    expect(unknown).toEqual([]);
  });

  it("lists each variable exactly once in the example", () => {
    // Two assignments to one key: the last wins, silently, and the one you
    // edited is usually the other one.
    const duplicated = exampleKeys.filter((key, index) => exampleKeys.indexOf(key) !== index);

    expect([...new Set(duplicated)]).toEqual([]);
  });

  it("explains every variable, because the explanation is what a failure prints", () => {
    // loadConfig prints the description beside anything missing or invalid. A
    // field without one produces an error naming a variable and nothing else,
    // which is the moment the description would have been worth most.
    const undescribed = schemaKeys.filter((key) => {
      const description = describeEnvVar(key);
      return description === undefined || description.trim() === "";
    });

    expect(undescribed).toEqual([]);
  });
});
