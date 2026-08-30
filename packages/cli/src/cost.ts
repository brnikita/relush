import type { Layer, Totals } from "@nodrel/telemetry";
import {
  aggregate,
  ESCALATION_SHARE_LIMIT,
  forSession,
  readEvents,
  since,
  weekAgo,
} from "@nodrel/telemetry";

/**
 * `/cost` — session and rolling-week totals by layer (SPEC §4.1).
 *
 * Rendered as plain text rather than a table library: this runs inside the TUI
 * on every invocation, and a dependency for column alignment is not worth the
 * install size.
 */

const usd = (n: number): string =>
  n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(5)}` : `$${n.toFixed(4)}`;

const tokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(1)}k`
      : String(n);

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

const LAYER_LABEL: Readonly<Record<Layer, string>> = {
  local: "local",
  flash: "flash",
  escalation: "escalate",
  byok: "byok",
};

function renderScope(label: string, totals: Totals): string[] {
  if (totals.steps === 0) return [`${label}: no steps recorded`];

  const lines = [`${label}`];
  const width = 8;

  for (const row of totals.byLayer) {
    const all = row.tokens.input + row.tokens.cached + row.tokens.output;
    const share =
      totals.steps === 0
        ? 0
        : all / (totals.tokens.input + totals.tokens.cached + totals.tokens.output);
    lines.push(
      `  ${(LAYER_LABEL[row.layer] ?? row.layer).padEnd(width)} ` +
        `${String(row.steps).padStart(4)} steps  ` +
        `${tokens(all).padStart(7)} tok  ` +
        `${pct(share).padStart(6)}  ` +
        `${usd(row.costUsd).padStart(9)}`,
    );
  }

  const allTokens = totals.tokens.input + totals.tokens.cached + totals.tokens.output;
  lines.push(
    `  ${"total".padEnd(width)} ${String(totals.steps).padStart(4)} steps  ` +
      `${tokens(allTokens).padStart(7)} tok  ` +
      `${"".padStart(6)}  ${usd(totals.costUsd).padStart(9)}`,
  );

  return lines;
}

export interface CostReportOptions {
  readonly telemetryPath: string;
  readonly sessionId?: string;
  readonly now?: Date;
}

/** Builds the `/cost` output. Returns text so it is testable without a TUI. */
export function costReport(options: CostReportOptions): string {
  const { events, skipped } = readEvents(options.telemetryPath);

  const sessionTotals = aggregate(
    options.sessionId ? forSession(events, options.sessionId) : events,
  );
  const weekTotals = aggregate(since(events, weekAgo(options.now)));

  const lines: string[] = [];
  lines.push(...renderScope("Session", sessionTotals));
  lines.push("");
  lines.push(...renderScope("Last 7 days", weekTotals));

  if (weekTotals.steps > 0) {
    lines.push("");
    lines.push(`  cache hit    ${pct(weekTotals.cacheHitRate)} of input tokens`);

    const escalation = pct(weekTotals.escalationShare);
    const overLimit = weekTotals.escalationShare > ESCALATION_SHARE_LIMIT;
    lines.push(
      `  escalation   ${escalation} of tokens` +
        // SPEC §4.5 makes this a hard invariant, so a breach is called out
        // rather than left for the reader to compute.
        (overLimit ? `  OVER the ${pct(ESCALATION_SHARE_LIMIT)} limit` : ""),
    );
    lines.push(`  local        ${pct(weekTotals.localShare)} of tokens`);
    lines.push(`  mean latency ${Math.round(weekTotals.meanLatencyMs)} ms/step`);
  }

  if (skipped.length > 0) {
    // Usually one torn line from a crash. Surfaced so a silently shrinking
    // total is never mistaken for cheaper operation.
    lines.push("");
    lines.push(`  note: ${skipped.length} unreadable record(s) skipped`);
  }

  return lines.join("\n");
}
