import type { RuntimeInfo } from "../application/ports/runtime-info.port.js";

/** The runtime port over the Node process. The only place these are read. */
export class ProcessRuntimeInfo implements RuntimeInfo {
  uptimeMs(): number {
    return Math.round(process.uptime() * 1_000);
  }

  memoryBytes(): number {
    return process.memoryUsage().rss;
  }
}
