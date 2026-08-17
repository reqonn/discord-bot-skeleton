import { z } from "zod";

/**
 * The complete set of environment variables this process understands.
 *
 * This schema is the single source of truth for configuration. Adding a
 * variable means adding it here and to `.env.example` — there is nowhere else
 * to add one, because `process.env` is unreadable outside this directory
 * (enforced by ESLint, docs/architecture.md RULE 6).
 *
 * Every field carries a `.describe()`. That text is not decoration: it is
 * printed next to the field when validation fails, so a misconfigured process
 * tells you what the variable is for instead of just naming it.
 */

export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const NODE_ENVS = ["development", "production", "test"] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/**
 * A port number, accepted as the string every environment actually provides.
 * 0 is allowed and means "let the OS assign a free port" — the standard way to
 * avoid collisions in tests and in sidecar deployments that discover the port.
 */
const port = () => z.coerce.number().int().min(0).max(65_535);

/** A duration in milliseconds, with a floor that rules out obvious typos. */
const durationMs = (min: number) => z.coerce.number().int().min(min);

export const envSchema = z.object({
  NODE_ENV: z
    .enum(NODE_ENVS)
    .default("development")
    .describe("Runtime mode. Selects in-memory or Redis-backed infrastructure."),

  LOG_LEVEL: z
    .enum(LOG_LEVELS)
    .optional()
    .describe("Minimum level to emit. Defaults to debug in development, info in production."),

  // ── Discord ────────────────────────────────────────────────────────────────
  DISCORD_TOKEN: z
    .string()
    .min(1)
    .describe("Bot token from the Discord developer portal. Secret — never logged."),

  DISCORD_CLIENT_ID: z
    .string()
    .min(1)
    .describe("Application (client) ID. Used to register slash commands."),

  DISCORD_DEV_GUILD_ID: z
    .string()
    .optional()
    .describe(
      "Guild for instant command registration in development. Required by `pnpm commands:deploy` outside production.",
    ),

  COMMAND_PREFIX: z
    .string()
    .max(8)
    .optional()
    .describe(
      'Prefix for message commands, so "!ping" runs the same command as "/ping". .env.example ships "!". Unset means off — deliberately, because message commands need the privileged Message Content intent and a deployment that never asked for one must not be given it.',
    ),

  DISCORD_READY_TIMEOUT_MS: durationMs(1_000)
    .default(60_000)
    .describe(
      "How long to wait for the gateway to report ready before aborting the boot, so the process never sits running-but-offline.",
    ),

  // ── PostgreSQL ─────────────────────────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .min(1)
    .describe("PostgreSQL connection string. Contains credentials — never logged."),

  DATABASE_POOL_MIN: z.coerce
    .number()
    .int()
    .min(0)
    .default(2)
    .describe("Connections kept open and pre-warmed at boot, so the first command pays no setup."),

  DATABASE_POOL_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .default(10)
    .describe("Upper bound on concurrent connections."),

  DATABASE_STATEMENT_TIMEOUT_MS: durationMs(100)
    .default(2_000)
    .describe(
      "Per-statement timeout. Kept below the Discord ack budget so a slow query fails fast instead of losing the interaction.",
    ),

  DATABASE_RETRY_DEADLINE_MS: durationMs(0)
    .default(2_000)
    .describe(
      "Total budget for retrying a failed query across all attempts. Sits below the 3s Discord acknowledgement window, so retrying can never be the reason an interaction is lost. 0 disables retries.",
    ),

  // ── Redis ──────────────────────────────────────────────────────────────────
  REDIS_URL: z
    .string()
    .optional()
    .describe(
      "Redis connection string. Optional everywhere: without it the bot uses in-process caching and locking, which is correct for a single instance and unsafe for more than one. Required in practice only when you run more than one replica.",
    ),

  // ── Operations ─────────────────────────────────────────────────────────────
  OPS_PORT: port()
    .optional()
    .describe(
      "Port serving /healthz, /readyz, and /metrics. Defaults to PORT if the host injects one, then 3000. 0 asks the OS for a free port.",
    ),

  PORT: port()
    .optional()
    .describe(
      "Injected by most hosts (Railway, Render, Fly). Used when OPS_PORT is unset, so a platform health check reaches the ops server without extra configuration.",
    ),

  OPS_METRICS_TOKEN: z
    .string()
    .optional()
    .describe(
      "Bearer token guarding /metrics, compared in constant time. Optional: unset, /metrics is open in development and switched off entirely in production. Set it to any long random string to enable metrics on a deployment.",
    ),

  SHUTDOWN_TIMEOUT_MS: durationMs(1_000)
    .default(10_000)
    .describe("Grace period for in-flight work during shutdown before the process is forced down."),
});

export type RawEnv = z.infer<typeof envSchema>;

/** The human description attached to a variable, for error output. */
export function describeEnvVar(name: string): string | undefined {
  const field: unknown = envSchema.shape[name as keyof typeof envSchema.shape];
  if (field && typeof field === "object" && "description" in field) {
    const { description } = field as { description?: unknown };
    return typeof description === "string" ? description : undefined;
  }
  return undefined;
}
