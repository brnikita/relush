import type { Layer } from "@nodrel/telemetry";

/**
 * Rule-based step classification (SPEC §4.5, §8).
 *
 * Rules first, a local-model classifier only if rules fall below 85% accuracy
 * on the labelled set. That ordering is deliberate: a classifier that needs a
 * model call to decide which model to call has to earn its own cost back before
 * it saves anything.
 */

/** What kind of work a step is, which decides the layer it can run on. */
export type TaskClass =
  | "trivial" // rename, comment, formatting: mechanical and verifiable
  | "local" // summarize, commit message, single-symbol edit with tests
  | "standard" // ordinary coding work
  | "complex"; // architecture, wide refactor, ambiguous debugging

export interface Classification {
  readonly taskClass: TaskClass;
  readonly layer: Layer;
  readonly reason: string;
}

/**
 * Signals that a step is mechanical.
 *
 * Matched against the prompt, so they describe how people phrase requests
 * rather than what the code does.
 */
const TRIVIAL_PATTERNS: readonly RegExp[] = [
  /\b(?:rename|rename to|typo|spelling)\b/i,
  /\b(?:add|update|fix) (?:a )?comment\b/i,
  /\b(?:format|reformat|prettier|lint fix)\b/i,
  /\bbump (?:the )?version\b/i,
];

const LOCAL_PATTERNS: readonly RegExp[] = [
  /\b(?:commit message|changelog entry)\b/i,
  /\b(?:summari[sz]e|describe) (?:this|the)\b/i,
  /\bwrite (?:a )?(?:doc|docstring|jsdoc)\b/i,
];

/**
 * Signals that a step is likely to need the strong model.
 *
 * Weighted toward ambiguity and breadth rather than difficulty: a hard but
 * well-specified change is what the default layer is for.
 */
const COMPLEX_PATTERNS: readonly RegExp[] = [
  /\b(?:architect|architecture|redesign|rewrite)\b/i,
  /\b(?:refactor) (?:the )?(?:entire|whole|all)\b/i,
  /\b(?:why|diagnose|root cause|investigate)\b/i,
  /\b(?:race condition|deadlock|memory leak|heisenbug)\b/i,
  /\bmigrat(?:e|ion)\b/i,
  /\bacross (?:the )?(?:codebase|repo|repository)\b/i,
];

const matches = (patterns: readonly RegExp[], text: string): boolean =>
  patterns.some((pattern) => pattern.test(text));

export interface ClassifyInput {
  readonly prompt: string;
  /** Files the change is expected to touch, from `impact()`. */
  readonly impactedFiles?: number;
  /** Whether the local layer is available on this machine. */
  readonly localAvailable?: boolean;
}

/** SPEC §4.5: impact wider than this escalates regardless of phrasing. */
export const IMPACT_ESCALATION_THRESHOLD = 12;

/**
 * Classifies a step and picks a layer.
 *
 * Impact size outranks phrasing. A request worded as a one-line change that
 * `impact()` says touches 30 files is a wide change whatever it was called, and
 * the graph's measurement is more trustworthy than the wording.
 */
export function classify(input: ClassifyInput): Classification {
  const prompt = input.prompt;
  const impacted = input.impactedFiles ?? 0;

  if (impacted > IMPACT_ESCALATION_THRESHOLD) {
    return {
      taskClass: "complex",
      layer: "escalation",
      reason: `impact spans ${impacted} files (> ${IMPACT_ESCALATION_THRESHOLD})`,
    };
  }

  if (matches(COMPLEX_PATTERNS, prompt)) {
    return {
      taskClass: "complex",
      layer: "escalation",
      reason: "prompt indicates open-ended work",
    };
  }

  if (matches(TRIVIAL_PATTERNS, prompt)) {
    return {
      taskClass: "trivial",
      layer: input.localAvailable ? "local" : "flash",
      reason: input.localAvailable
        ? "mechanical change, local model is sufficient"
        : "mechanical change, no local model available",
    };
  }

  if (matches(LOCAL_PATTERNS, prompt)) {
    return {
      taskClass: "local",
      layer: input.localAvailable ? "local" : "flash",
      reason: input.localAvailable
        ? "summarization-shaped, runs locally at no cost"
        : "summarization-shaped, no local model available",
    };
  }

  return { taskClass: "standard", layer: "flash", reason: "ordinary coding step" };
}
