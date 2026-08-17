import { startApplication, type Application } from "#app/bootstrap.js";

import { onTerminalHangup } from "#platform/lifecycle/hangup.js";

import { ConfigurationError, isAppError } from "#shared/errors/app-error.js";

/**
 * Process entry point.
 *
 * Contains no business logic and never will (docs/architecture.md RULE 9). Its
 * entire job is: start the application, translate process signals into a
 * graceful shutdown, and make sure a failure is legible on the way out.
 */

const FATAL_EXIT_CODE = 1;

async function main(): Promise<void> {
  const app = await startApplication();

  installSignalHandlers(app);
  installCrashHandlers(app);
}

function installSignalHandlers(app: Application): void {
  // SIGTERM  an orchestrator stopping the process
  // SIGINT   Ctrl-C
  // SIGHUP   the terminal went away. On Windows this is what Node raises for
  //          the console CTRL_CLOSE_EVENT, which is delivered to every process
  //          attached to that console — so it reaches the bot even though
  //          `pnpm dev` runs it two processes down. This is the one that closing
  //          a VS Code terminal actually produces.
  // SIGBREAK Ctrl-Break, Windows only. Registering it elsewhere throws.
  const signals: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];
  if (process.platform === "win32") signals.push("SIGBREAK");

  for (const signal of signals) {
    process.on(signal, () => {
      void stopAndExit(app, signal);
    });
  }

  // Belt and braces for the same case, by a different route: stdin is inherited
  // down the whole chain, so a destroyed console ends it however deep the
  // process sits. Only arms for a real terminal — see hangup.ts for why that
  // guard is load-bearing.
  const armed = onTerminalHangup(process.stdin, () => {
    void stopAndExit(app, "terminal-closed");
  });

  app.logger.debug("Shutdown signals installed", {
    signals: signals.join(","),
    stdinHangup: armed,
  });
}

function installCrashHandlers(app: Application): void {
  // An unhandled rejection means some path is not returning its promise. The
  // process state is unknown from here, so shut down cleanly rather than
  // continuing to serve interactions from a process we cannot reason about.
  process.on("unhandledRejection", (reason) => {
    app.logger.fatal("Unhandled promise rejection", { error: reason });
    void stopAndExit(app, "unhandledRejection", FATAL_EXIT_CODE);
  });

  process.on("uncaughtException", (error) => {
    app.logger.fatal("Uncaught exception", { error });
    void stopAndExit(app, "uncaughtException", FATAL_EXIT_CODE);
  });
}

async function stopAndExit(app: Application, reason: string, code = 0): Promise<void> {
  const completed = await app.shutdown(reason);
  process.exit(completed ? code : FATAL_EXIT_CODE);
}

main().catch((error: unknown) => {
  // Startup failed, so there is no logger to route this through — and for a
  // configuration problem a bare, readable message is more useful than a
  // structured record anyway.
  if (error instanceof ConfigurationError) {
    process.stderr.write(`\n${error.detail ?? error.message}\n\n`);
  } else if (isAppError(error)) {
    process.stderr.write(`\nStartup failed: ${error.detail ?? error.message}\n\n`);
  } else {
    process.stderr.write(
      `\nStartup failed:\n${String(error instanceof Error ? error.stack : error)}\n\n`,
    );
  }

  // Set the code and let the loop drain rather than calling process.exit: the
  // logger's transport runs on a worker thread, and tearing the process down
  // mid-flush loses the very message being written — and on Windows takes the
  // runtime down with a libuv assertion instead of a readable error.
  process.exitCode = FATAL_EXIT_CODE;
});
