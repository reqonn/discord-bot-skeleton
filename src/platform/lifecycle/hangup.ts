/**
 * The stream a hangup can be observed on. Narrowed to what is used, so a test
 * can pass a plain object rather than standing up a real TTY.
 */
export interface HangupStream {
  readonly isTTY?: boolean | undefined;
  on(event: "end" | "close" | "error", listener: () => void): unknown;
  resume(): unknown;
}

/**
 * Shuts down when the terminal that started the process goes away.
 *
 * Closing a VS Code terminal on Windows kills the shell without signalling
 * anything below it, and `pnpm dev` sits two processes above the bot
 * (pnpm → tsx watch → node). Neither SIGTERM nor SIGINT nor SIGHUP arrives, so
 * the bot keeps running — holding a gateway connection and a database pool —
 * with no window left to stop it from.
 *
 * stdin is the one thing that does reach it. The handle is inherited down the
 * whole chain, so when the console is destroyed every process holding it sees
 * the stream end, however deep it sits. That makes this work regardless of what
 * happens to the intermediate processes.
 *
 * @returns whether a handler was armed, so a caller can log the difference.
 */
export function onTerminalHangup(stream: HangupStream, handler: () => void): boolean {
  // Only for a real terminal. Under a service manager, in CI, or with stdin
  // redirected from /dev/null, the stream is already closed or ends
  // immediately — arming this there would shut the process down seconds after
  // boot, in production, for no reason.
  if (stream.isTTY !== true) return false;

  let fired = false;
  const once = (): void => {
    if (fired) return;
    fired = true;
    handler();
  };

  stream.on("end", once);
  stream.on("close", once);
  // A destroyed console surfaces as an error on some Windows terminals rather
  // than a clean end. Both mean the same thing here.
  stream.on("error", once);

  // Without this the stream stays paused and never emits anything.
  stream.resume();

  return true;
}
