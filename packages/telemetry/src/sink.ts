import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TelemetryEvent } from "./events.ts";
import { validateEvent } from "./validate.ts";

/**
 * Append-only JSONL sink (SPEC §4.9).
 *
 * Telemetry is written synchronously and append-only. Both choices are about
 * surviving a kill -9 (SPEC §5): buffered writes lose the final steps of the
 * session that crashed — exactly the steps worth reading — and rewriting a
 * whole file risks losing everything already recorded.
 *
 * `NODREL_TELEMETRY=off` disables writing entirely. The default is `local`,
 * which writes to disk and uploads nothing.
 */

export type TelemetryMode = "off" | "local" | "aggregate";

export const parseMode = (raw: string | undefined): TelemetryMode =>
  raw === "off" || raw === "aggregate" ? raw : "local";

export interface SinkOptions {
  readonly path: string;
  readonly mode?: TelemetryMode;
  /** Overridable for tests; defaults to a real append to disk. */
  readonly write?: (path: string, line: string) => void;
}

const defaultWrite = (path: string, line: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line, "utf8");
};

export class JsonlSink {
  private readonly path: string;
  private readonly mode: TelemetryMode;
  private readonly write: (path: string, line: string) => void;

  constructor(options: SinkOptions) {
    this.path = options.path;
    this.mode = options.mode ?? "local";
    this.write = options.write ?? defaultWrite;
  }

  /**
   * Records one event.
   *
   * Validates before writing: an invalid record on disk is worse than a loud
   * failure here, because it corrupts every later aggregate silently.
   */
  record(event: TelemetryEvent): void {
    if (this.mode === "off") return;

    const validated = validateEvent(event);
    if (!validated.ok) {
      throw new TypeError(`refusing to record invalid telemetry event: ${validated.error}`);
    }

    this.write(this.path, `${JSON.stringify(validated.value)}\n`);
  }
}

export interface ReadResult {
  readonly events: TelemetryEvent[];
  /**
   * Lines that could not be parsed or validated, with the reason.
   *
   * A crash mid-write leaves a truncated final line. That is expected, not
   * exceptional, so reading reports it rather than throwing — one torn line
   * must not make an entire session's telemetry unreadable.
   */
  readonly skipped: { readonly line: number; readonly reason: string }[];
}

/** Reads a JSONL telemetry file, tolerating a torn trailing line. */
export function readEvents(path: string): ReadResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], skipped: [] };
    throw error;
  }

  const events: TelemetryEvent[] = [];
  const skipped: { line: number; reason: string }[] = [];

  const lines = raw.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped.push({ line: index + 1, reason: "malformed JSON" });
      continue;
    }

    const validated = validateEvent(parsed);
    if (validated.ok) events.push(validated.value);
    else skipped.push({ line: index + 1, reason: validated.error });
  }

  return { events, skipped };
}
