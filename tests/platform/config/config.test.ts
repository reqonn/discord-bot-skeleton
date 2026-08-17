import { describe, expect, it } from "vitest";

import { loadConfig } from "#platform/config/config.js";

import { ConfigurationError } from "#shared/errors/app-error.js";

/** The smallest environment that is actually valid. */
const MINIMAL = {
  DISCORD_TOKEN: "token",
  DISCORD_CLIENT_ID: "1234567890",
  DATABASE_URL: "postgres://bot:bot@127.0.0.1:55432/bot",
} as const;

function expectConfigError(source: Record<string, string | undefined>): ConfigurationError {
  try {
    loadConfig(source);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return error as ConfigurationError;
  }
  throw new Error("Expected loadConfig to throw, but it returned a config.");
}

describe("loadConfig", () => {
  it("accepts a minimal development environment", () => {
    const config = loadConfig({ ...MINIMAL });

    expect(config.env).toBe("development");
    expect(config.discord.token).toBe("token");
    expect(config.database.url).toBe(MINIMAL.DATABASE_URL);
  });

  it("applies defaults for everything optional", () => {
    const config = loadConfig({ ...MINIMAL });

    expect(config.ops.port).toBe(3_000);
    expect(config.database.poolMin).toBe(2);
    expect(config.database.poolMax).toBe(10);
    expect(config.shutdownTimeoutMs).toBe(10_000);
    expect(config.logLevel).toBe("debug");
  });

  it("coerces numeric variables from their string form", () => {
    const config = loadConfig({ ...MINIMAL, OPS_PORT: "8080", DATABASE_POOL_MAX: "25" });

    expect(config.ops.port).toBe(8_080);
    expect(config.database.poolMax).toBe(25);
  });

  describe("the message-command prefix", () => {
    it("accepts a prefix", () => {
      expect(loadConfig({ ...MINIMAL, COMMAND_PREFIX: "!" }).discord.prefix).toBe("!");
    });

    it("accepts a multi-character prefix", () => {
      expect(loadConfig({ ...MINIMAL, COMMAND_PREFIX: "bot!" }).discord.prefix).toBe("bot!");
    });

    it.each([
      ["unset", undefined],
      ["blank", ""],
    ])("is off when %s, rather than defaulting on", (_case, value) => {
      // No default, deliberately. Message commands need the privileged Message
      // Content intent, and requesting one the application has not been granted
      // makes Discord refuse the login — so a deployment that never mentioned
      // COMMAND_PREFIX must not silently acquire it. `.env.example` ships "!",
      // which is what gives local development the prefix by default.
      expect(loadConfig({ ...MINIMAL, COMMAND_PREFIX: value }).discord.prefix).toBeUndefined();
    });
  });

  it("treats an empty string as unset", () => {
    // `FOO=` in a .env file is how people disable a variable. Without the blank
    // filter this coerces to 0 or "" and passes validation with nonsense.
    const config = loadConfig({ ...MINIMAL, REDIS_URL: "", LOG_LEVEL: "" });

    expect(config.redis.enabled).toBe(false);
    expect(config.logLevel).toBe("debug");
  });

  describe("reporting", () => {
    it("reports every missing variable in one failure", () => {
      const error = expectConfigError({});

      // The whole point: one restart tells you everything that is wrong.
      expect(error.detail).toContain("3 problems");
      expect(error.detail).toContain("DISCORD_TOKEN");
      expect(error.detail).toContain("DISCORD_CLIENT_ID");
      expect(error.detail).toContain("DATABASE_URL");
    });

    it("explains what each variable is for", () => {
      const error = expectConfigError({});

      expect(error.detail).toContain("Bot token from the Discord developer portal");
    });

    it("distinguishes an invalid value from a missing one", () => {
      const error = expectConfigError({ ...MINIMAL, OPS_PORT: "not-a-port" });

      expect(error.detail).toContain("OPS_PORT");
      expect(error.detail).not.toContain("is required but was not set");
    });

    it("keeps secrets out of the failure message", () => {
      const error = expectConfigError({ ...MINIMAL, DISCORD_TOKEN: undefined, OPS_PORT: "0" });

      expect(error.detail).not.toContain(MINIMAL.DATABASE_URL);
    });
  });

  describe("development mode", () => {
    it("runs without Redis", () => {
      const config = loadConfig({ ...MINIMAL });

      expect(config.redis.enabled).toBe(false);
      expect(config.redis.url).toBeUndefined();
    });

    it("registers commands to the dev guild and shows error detail", () => {
      const config = loadConfig({ ...MINIMAL });

      expect(config.profile.commandScope).toBe("guild");
      expect(config.profile.showErrorDetail).toBe(true);
      expect(config.profile.prettyLogs).toBe(true);
      expect(config.profile.loadDevOnlyFeatures).toBe(true);
    });
  });

  describe("production guards", () => {
    const PRODUCTION = {
      ...MINIMAL,
      NODE_ENV: "production",
      REDIS_URL: "redis://127.0.0.1:6379",
      OPS_METRICS_TOKEN: "secret",
    } as const;

    it("accepts a complete production environment", () => {
      const config = loadConfig({ ...PRODUCTION });

      expect(config.redis.enabled).toBe(true);
      expect(config.profile.commandScope).toBe("global");
      expect(config.profile.showErrorDetail).toBe(false);
      expect(config.profile.prettyLogs).toBe(false);
      expect(config.profile.loadDevOnlyFeatures).toBe(false);
      expect(config.logLevel).toBe("info");
    });

    it("starts without Redis, because a single-instance bot does not need it", () => {
      // Deliberately permitted. Refusing here would make the simplest useful
      // deployment — one replica, one database, no Redis — the one this
      // skeleton rejects. The cost is warned about loudly in app/wiring.ts.
      const config = loadConfig({ ...PRODUCTION, REDIS_URL: undefined });

      expect(config.redis.enabled).toBe(false);
    });

    it("starts without a metrics token", () => {
      const config = loadConfig({ ...PRODUCTION, OPS_METRICS_TOKEN: undefined });

      expect(config.ops.metricsToken).toBeUndefined();
    });

    it("never allows unguarded metrics in production", () => {
      // The safety this replaces the hard failure with: no token in production
      // means /metrics is not served, rather than served to everyone.
      const config = loadConfig({ ...PRODUCTION, OPS_METRICS_TOKEN: undefined });

      expect(config.profile.allowUnguardedMetrics).toBe(false);
    });

    it("allows unguarded metrics outside production, where it is convenient", () => {
      expect(loadConfig({ ...MINIMAL }).profile.allowUnguardedMetrics).toBe(true);
    });
  });

  it("rejects a pool minimum above its maximum", () => {
    const error = expectConfigError({
      ...MINIMAL,
      DATABASE_POOL_MIN: "20",
      DATABASE_POOL_MAX: "5",
    });

    expect(error.detail).toContain("DATABASE_POOL_MIN");
  });

  it("freezes the result so configuration cannot drift after startup", () => {
    const config = loadConfig({ ...MINIMAL });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.discord)).toBe(true);
    expect(Object.isFrozen(config.profile)).toBe(true);
  });
});
