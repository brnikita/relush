import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only conversation journal (SPEC §5 Reliability: survive `kill -9`).
 *
 * One JSON line per message, written synchronously as each message lands.
 * The same two choices as the telemetry sink, for the same reason: buffered
 * writes lose exactly the messages from the turn that crashed, and rewriting a
 * whole file risks losing everything before it.
 *
 * A torn trailing line — the signature of a crash mid-write — is tolerated on
 * read and reported, so one partial record never makes a session unresumable.
 */

export interface JournalRecord {
  readonly seq: number;
  readonly ts: string;
  readonly message: unknown;
}

export interface JournalReadResult {
  readonly records: JournalRecord[];
  readonly torn: number;
}

export class Journal {
  private seq = 0;

  constructor(private readonly path: string) {}

  /** Appends one message. Throws on I/O failure rather than dropping it. */
  append(message: unknown): JournalRecord {
    this.seq += 1;
    const record: JournalRecord = { seq: this.seq, ts: new Date().toISOString(), message };
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  }

  /** Reads back every intact record, skipping a torn final line. */
  static read(path: string): JournalReadResult {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], torn: 0 };
      throw error;
    }

    const records: JournalRecord[] = [];
    let torn = 0;
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as JournalRecord;
        if (typeof parsed.seq === "number" && "message" in parsed) records.push(parsed);
        else torn += 1;
      } catch {
        torn += 1;
      }
    }
    return { records, torn };
  }

  /** Resumes numbering after the last intact record, so seq stays monotonic. */
  static resume(path: string): { journal: Journal; messages: unknown[]; torn: number } {
    const { records, torn } = Journal.read(path);
    const journal = new Journal(path);
    journal.seq = records.at(-1)?.seq ?? 0;
    return { journal, messages: records.map((r) => r.message), torn };
  }
}
