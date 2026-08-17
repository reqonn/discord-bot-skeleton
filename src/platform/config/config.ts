import { ConfigurationError } from "../../shared/errors/app-error.js";

import { describeEnvVar, envSchema, type LogLevel, type NodeEnv } from "./config.schema.js";

/**
 * Semantic capabilities derived from the environment, once, at startup.
 *
 * Deliberately expressed as *what changes* rather than *which environment we
 * are in*. Code asks `profile.showErrorDetail`, never `env === "production"`,
 * which is what keeps environment branching out of the rest of the codebase
 * (docs/architecture.md RULE 8). The only consumer that reads more than one of
 * these is src/app/wiring.ts.
 */
export interface RuntimeProfile {
  readonly name: NodeEnv;
  /** Guild-scoped registration appears instantly; global registration is cached by Discord. */
  readonly commandScope: "guild" | "global";
  /** Whether `AppError.detail` reaches the user. Never true in production. */
  readonly showErrorDetail: boolean;
  /** Human-readable log lines instead of newline-delimited JSON. */
  readonly prettyLogs: boolean;
  /** Whether feature manifests marked `devOnly` are registered. */
  readonly loadDevOnlyFeatures: boolean;
  /**
   * Whether `/metrics` may be served without a token.
   *
   * True only outside production. With no token set, production serves 404
   * rather than the metrics — a skeleton must not turn "I did not set an
   * optional variable" into a public endpoint describing your traffic.
   */
  readonly allowUnguardedMetrics: boolean;
}

export interface Config {
  readonly env: NodeEnv;
  readonly profile: RuntimeProfile;
  readonly logLevel: LogLevel;

  readonly discord: {
    readonly token: string;
    readonly clientId: string;
    readonly devGuildId: string | undefined;
    readonly readyTimeoutMs: number;
    /**
     * Prefix for message commands, or undefined when they are off.
     *
     * Undefined is load-bearing rather than cosmetic: message commands require
     * the privileged Message Content intent, and requesting an intent the
     * application has not been granted makes the gateway reject the login
     * outright. A bot that does not want them must not ask for it.
     */
    readonly prefix: string | undefined;
  };

  readonly database: {
    readonly url: string;
    readonly poolMin: number;
    readonly poolMax: number;
    readonly statementTimeoutMs: number;
    readonly retryDeadlineMs: number;
  };

  readonly redis: {
    readonly url: string | undefined;
    /**
     * Whether Redis-backed implementations should be wired. When false the bot
     * runs on in-process cache and locks — correct for one local developer,
     * unsafe for more than one instance, which is why production requires it.
     */
    readonly enabled: boolean;
  };

  readonly ops: {
    readonly port: number;
    readonly metricsToken: string | undefined;
  };

  readonly shutdownTimeoutMs: number;
}

interface ConfigProblem {
  readonly variable: string;
  readonly problem: string;
}

/**
 * Reads, validates, and freezes configuration.
 *
 * Takes the environment as an argument rather than reaching for `process.env`
 * directly, so tests exercise real validation against a plain object instead of
 * mutating global state.
 *
 * @throws ConfigurationError listing *every* problem found. Fixing configuration
 *   one restart at a time is miserable, so a single failure reports the lot.
 */
export function loadConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
): Config {
  // An unset variable and one set to "" mean the same thing to a human, so make
  // them mean the same thing to the schema. Without this, `FOO=` in a .env file
  // coerces to 0 or "" and silently passes.
  const present = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ""),
  );

  const parsed = envSchema.safeParse(present);
  if (!parsed.success) {
    throw new ConfigurationError(
      formatProblems(
        parsed.error.issues.map((issue) => {
          const variable = String(issue.path[0] ?? "(unknown)");
          return {
            variable,
            problem: variable in present ? issue.message : "is required but was not set",
          };
        }),
      ),
    );
  }

  const env = parsed.data;
  const isProduction = env.NODE_ENV === "production";

  // Cross-field rules the schema cannot express on its own.
  const problems: ConfigProblem[] = [];

  // REDIS_URL and OPS_METRICS_TOKEN are deliberately *not* required in
  // production. Plenty of bots run a single instance and never need Redis, and
  // refusing to boot without it would make the simplest useful deployment the
  // one this skeleton rejects. Both degrade to something safe instead:
  // without Redis the process warns loudly that it must stay single-instance
  // (see app/wiring.ts), and without a token /metrics is not served at all.

  if (env.DATABASE_POOL_MIN > env.DATABASE_POOL_MAX) {
    problems.push({
      variable: "DATABASE_POOL_MIN",
      problem: `is ${String(env.DATABASE_POOL_MIN)}, which exceeds DATABASE_POOL_MAX (${String(env.DATABASE_POOL_MAX)}).`,
    });
  }

  if (problems.length > 0) {
    throw new ConfigurationError(formatProblems(problems));
  }

  const profile: RuntimeProfile = {
    name: env.NODE_ENV,
    commandScope: isProduction ? "global" : "guild",
    showErrorDetail: !isProduction,
    prettyLogs: !isProduction,
    loadDevOnlyFeatures: !isProduction,
    allowUnguardedMetrics: !isProduction,
  };

  return deepFreeze({
    env: env.NODE_ENV,
    profile,
    logLevel: env.LOG_LEVEL ?? (isProduction ? "info" : "debug"),

    discord: {
      token: env.DISCORD_TOKEN,
      clientId: env.DISCORD_CLIENT_ID,
      devGuildId: env.DISCORD_DEV_GUILD_ID,
      readyTimeoutMs: env.DISCORD_READY_TIMEOUT_MS,
      // Blank is filtered to absent above, so `COMMAND_PREFIX=` and no line at
      // all mean the same thing: message commands off. There is deliberately no
      // default — a deployment that never set it must not end up requesting a
      // privileged intent it has not been granted, which the gateway answers by
      // refusing the login outright.
      prefix: env.COMMAND_PREFIX,
    },

    database: {
      url: env.DATABASE_URL,
      poolMin: env.DATABASE_POOL_MIN,
      poolMax: env.DATABASE_POOL_MAX,
      statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
      retryDeadlineMs: env.DATABASE_RETRY_DEADLINE_MS,
    },

    redis: {
      url: env.REDIS_URL,
      enabled: env.REDIS_URL !== undefined,
    },

    ops: {
      // Hosts that inject PORT expect the process to listen on it; honouring
      // that means a platform health check works with no extra configuration.
      port: env.OPS_PORT ?? env.PORT ?? 3_000,
      metricsToken: env.OPS_METRICS_TOKEN,
    },

    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  });
}

/**
 * Renders problems as a block a human can act on without opening the source:
 * the variable, what is wrong with it, and what the variable is for.
 */
function formatProblems(problems: readonly ConfigProblem[]): string {
  const width = Math.max(...problems.map((p) => p.variable.length));

  const lines = problems.flatMap((problem) => {
    const rendered = [`  ${problem.variable.padEnd(width)}  ${problem.problem}`];
    const description = describeEnvVar(problem.variable);
    if (description !== undefined) {
      rendered.push(`  ${" ".repeat(width)}  → ${description}`);
    }
    return rendered;
  });

  const count = problems.length === 1 ? "1 problem" : `${String(problems.length)} problems`;

  return [
    `Configuration is invalid — ${count}:`,
    "",
    ...lines,
    "",
    "See .env.example for the full annotated list.",
  ].join("\n");
}

/** Freezes nested plain objects so configuration cannot drift after startup. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}
