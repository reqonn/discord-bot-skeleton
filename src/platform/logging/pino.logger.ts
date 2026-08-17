import { pino, type DestinationStream, type LoggerOptions, type Logger as PinoLogger } from "pino";

import type { Config } from "../config/config.js";
import { getRequestContext } from "../context/request-context.js";

import { serializeError } from "./error.serializer.js";
import type { ErrorLogFields, LogFields, Logger } from "./logger.contract.js";

/**
 * Fields scrubbed from every record, at any depth.
 *
 * A backstop, not the policy: nothing should be putting a token in a log field
 * in the first place. It exists because the one time it happens will be in an
 * error object someone spread into the record without looking.
 */
const REDACTED_PATHS = [
  "token",
  "*.token",
  "*.*.token",
  "password",
  "*.password",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "apiKey",
  "*.apiKey",
  "databaseUrl",
  "*.databaseUrl",
  "connectionString",
  "*.connectionString",
];

/**
 * Pulls request context onto every record automatically.
 *
 * This is the whole reason the ambient context exists: without it, every log
 * call needs the correlation id passed in, and the one call that forgets is the
 * one you need during an incident.
 */
function requestContextMixin(): Record<string, unknown> {
  const context = getRequestContext();
  if (context === undefined) return {};

  return {
    correlationId: context.correlationId,
    source: context.source,
    operation: context.operation,
    ...(context.guildId !== undefined ? { guildId: context.guildId } : {}),
    ...(context.userId !== undefined ? { userId: context.userId } : {}),
  };
}

/**
 * Adapts pino to the Logger port.
 *
 * Thin by design — argument order, error serialisation, and nothing else. Any
 * logic beyond that belongs to a caller, not to the logging layer.
 */
class PinoLoggerAdapter implements Logger {
  constructor(private readonly pino: PinoLogger) {}

  trace(message: string, fields?: ErrorLogFields): void {
    this.pino.trace(withSerializedError(fields), message);
  }

  debug(message: string, fields?: ErrorLogFields): void {
    this.pino.debug(withSerializedError(fields), message);
  }

  info(message: string, fields?: ErrorLogFields): void {
    this.pino.info(withSerializedError(fields), message);
  }

  warn(message: string, fields?: ErrorLogFields): void {
    this.pino.warn(withSerializedError(fields), message);
  }

  error(message: string, fields?: ErrorLogFields): void {
    this.pino.error(withSerializedError(fields), message);
  }

  fatal(message: string, fields?: ErrorLogFields): void {
    this.pino.fatal(withSerializedError(fields), message);
  }

  child(bindings: LogFields): Logger {
    return new PinoLoggerAdapter(this.pino.child(bindings));
  }
}

function withSerializedError(fields: ErrorLogFields | undefined): Record<string, unknown> {
  if (fields === undefined) return {};
  const { error, ...rest } = fields;
  return error === undefined ? { ...rest } : { ...rest, error: serializeError(error) };
}

/**
 * Builds the application logger.
 *
 * @param destination Overrides the output stream. Tests pass a capture stream
 *   so they can assert on real records; passing one also skips the pretty-print
 *   transport, which would otherwise spawn a worker thread per test file.
 */
export function createLogger(config: Config, destination?: DestinationStream): Logger {
  const options = {
    level: config.logLevel,
    base: { env: config.env },
    mixin: requestContextMixin,
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
  } satisfies LoggerOptions;

  if (destination !== undefined) {
    return new PinoLoggerAdapter(pino(options, destination));
  }

  if (config.profile.prettyLogs) {
    return new PinoLoggerAdapter(
      pino({
        ...options,
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname,env,source",
            messageFormat: "{if correlationId}[90m[{correlationId}][39m {end}{msg}",
          },
        },
      }),
    );
  }

  return new PinoLoggerAdapter(pino(options));
}
