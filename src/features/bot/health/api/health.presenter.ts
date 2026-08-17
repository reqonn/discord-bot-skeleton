import type { Response, Section } from "#discord/contracts/response.contract.js";

import type { HealthReport } from "../application/check-health.usecase.js";

/**
 * What `/ping` says.
 *
 * **The default frame — no glyph, no colour.** Being asked whether the bot is
 * up is not something that *happened*, and a green tick on it would spend the
 * vocabulary that makes a real success stand out. A dependency actually being
 * down is a warning, and that one is badged, because that one happened.
 *
 * There is no sentence above the numbers either: the numbers are the answer,
 * and a line saying "Pong." over them is a label for something already
 * labelled.
 */

export function pong(report: HealthReport, gatewayMs: number | null): Response {
  const sections: Section[] = [
    {
      name: "Connection",
      rows: [
        { name: "Gateway", value: gateway(gatewayMs) },
        { name: "Uptime", value: `\`${duration(report.uptimeMs)}\`` },
        {
          name: "Memory",
          value: `\`${String(Math.round(report.memoryBytes / 1_048_576))} MB\``,
        },
      ],
    },
    {
      name: "Dependencies",
      rows: report.checks.map((check) => ({
        name: capitalise(check.name),
        value: check.healthy
          ? `\`${String(Math.round(check.latencyMs))} ms\``
          : `**down** — ${check.detail ?? "no detail"}`,
      })),
    },
  ];

  return report.healthy
    ? { kind: "info", sections }
    : { kind: "warning", text: "Something the bot depends on is **down**.", sections };
}

/**
 * The gateway heartbeat, or an honest dash.
 *
 * Discord reports -1 until the first heartbeat is acknowledged, which measurably
 * takes about thirty seconds after connecting — so under `tsx watch`, where the
 * bot restarts on every save, this is unavailable more often than not. A dash
 * says "not measured yet"; "-1 ms" would be a lie with a number on it.
 */
function gateway(ms: number | null): string {
  return ms === null ? "—" : `\`${String(ms)} ms\``;
}

/**
 * `1d, 2h, 54m, 24s`.
 *
 * Leading units are dropped once they are zero — a bot up for six minutes says
 * `6m, 12s`, not `0d, 0h, 6m, 12s` — but seconds always survive, because the
 * uptime people actually stare at is the one right after a restart.
 */
function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const parts: string[] = [];

  const units = [
    ["d", 86_400],
    ["h", 3_600],
    ["m", 60],
  ] as const;

  let remaining = total;
  for (const [suffix, size] of units) {
    const value = Math.floor(remaining / size);
    // Skipped only while nothing larger has been shown: "1d, 0h, 5m" is
    // honest, "0d, 0h, 5m" is padding.
    if (value > 0 || parts.length > 0) parts.push(`${String(value)}${suffix}`);
    remaining %= size;
  }

  parts.push(`${String(remaining)}s`);
  return parts.join(", ");
}

function capitalise(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}
