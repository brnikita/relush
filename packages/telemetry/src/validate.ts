import type { Layer, TelemetryEvent, TokenUsage, VerificationResult } from "./events.ts";
import { LAYERS } from "./events.ts";

/**
 * Structural validation for telemetry records.
 *
 * Hand-rolled rather than schema-library-backed: this package is loaded by the
 * harness on every step, and SPEC §4.1 puts the whole fixed overhead under
 * 2,000 tokens and §5 puts harness-added latency under 150 ms. A validator
 * this small does not justify a dependency.
 *
 * Validation is deliberately strict on read. A malformed record silently
 * treated as valid would corrupt an eval comparison, and a corrupted eval
 * comparison is worse than a missing one.
 */

export interface ValidationFailure {
  readonly ok: false;
  readonly error: string;
}

export interface ValidationSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

export type Validated<T> = ValidationSuccess<T> | ValidationFailure;

const fail = (error: string): ValidationFailure => ({ ok: false, error });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Non-negative and finite. Token counts and costs are never negative. */
const isCount = (v: unknown): v is number => isFiniteNumber(v) && v >= 0;

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const isIsoTimestamp = (v: unknown): v is string =>
  isNonEmptyString(v) && !Number.isNaN(Date.parse(v));

const isLayer = (v: unknown): v is Layer => LAYERS.includes(v as Layer);

const isVerification = (v: unknown): v is VerificationResult =>
  v === "pass" || v === "fail" || v === "none";

const validateUsage = (v: unknown): Validated<TokenUsage> => {
  if (!isRecord(v)) return fail("tokens must be an object");
  if (!isCount(v["input"])) return fail("tokens.input must be a non-negative number");
  if (!isCount(v["cached"])) return fail("tokens.cached must be a non-negative number");
  if (!isCount(v["output"])) return fail("tokens.output must be a non-negative number");
  return {
    ok: true,
    value: { input: v["input"], cached: v["cached"], output: v["output"] },
  };
};

/** Validates an unknown value as a telemetry event. */
export function validateEvent(input: unknown): Validated<TelemetryEvent> {
  if (!isRecord(input)) return fail("event must be an object");

  if (!isIsoTimestamp(input["ts"])) return fail("ts must be an ISO-8601 timestamp");
  if (!isNonEmptyString(input["sessionId"])) return fail("sessionId must be a non-empty string");

  const base = { ts: input["ts"], sessionId: input["sessionId"] };

  switch (input["type"]) {
    case "step": {
      if (!isNonEmptyString(input["stepId"])) return fail("stepId must be a non-empty string");
      if (!isLayer(input["layer"])) return fail(`layer must be one of ${LAYERS.join(", ")}`);
      if (!isNonEmptyString(input["model"])) return fail("model must be a non-empty string");
      if (!isNonEmptyString(input["provider"])) return fail("provider must be a non-empty string");
      if (!isCount(input["costUsd"])) return fail("costUsd must be a non-negative number");
      if (!isCount(input["latencyMs"])) return fail("latencyMs must be a non-negative number");

      const tokens = validateUsage(input["tokens"]);
      if (!tokens.ok) return tokens;

      const verification = input["verification"];
      if (verification !== undefined && !isVerification(verification)) {
        return fail("verification must be pass, fail, or none");
      }

      return {
        ok: true,
        value: {
          ...base,
          type: "step",
          stepId: input["stepId"],
          layer: input["layer"],
          model: input["model"],
          provider: input["provider"],
          tokens: tokens.value,
          costUsd: input["costUsd"],
          latencyMs: input["latencyMs"],
          ...(verification === undefined ? {} : { verification }),
        },
      };
    }

    case "retrieval_miss": {
      if (!isNonEmptyString(input["queryId"])) return fail("queryId must be a non-empty string");
      if (!isNonEmptyString(input["path"])) return fail("path must be a non-empty string");
      if (!isCount(input["wastedTokens"]))
        return fail("wastedTokens must be a non-negative number");
      return {
        ok: true,
        value: {
          ...base,
          type: "retrieval_miss",
          queryId: input["queryId"],
          path: input["path"],
          wastedTokens: input["wastedTokens"],
        },
      };
    }

    case "compaction": {
      const kind = input["kind"];
      if (kind !== "mask" && kind !== "compress" && kind !== "summarize") {
        return fail("kind must be mask, compress, or summarize");
      }
      if (!isCount(input["tokensBefore"]))
        return fail("tokensBefore must be a non-negative number");
      if (!isCount(input["tokensAfter"])) return fail("tokensAfter must be a non-negative number");

      const sha = input["sha"];
      if (sha !== undefined && !isNonEmptyString(sha))
        return fail("sha must be a non-empty string");

      return {
        ok: true,
        value: {
          ...base,
          type: "compaction",
          kind,
          tokensBefore: input["tokensBefore"],
          tokensAfter: input["tokensAfter"],
          ...(sha === undefined ? {} : { sha }),
        },
      };
    }

    case "layer_switch": {
      if (!isLayer(input["from"])) return fail(`from must be one of ${LAYERS.join(", ")}`);
      if (!isLayer(input["to"])) return fail(`to must be one of ${LAYERS.join(", ")}`);
      if (!isNonEmptyString(input["reason"])) return fail("reason must be a non-empty string");
      return {
        ok: true,
        value: {
          ...base,
          type: "layer_switch",
          from: input["from"],
          to: input["to"],
          reason: input["reason"],
        },
      };
    }

    case "local_degraded": {
      if (!isNonEmptyString(input["reason"])) return fail("reason must be a non-empty string");
      return { ok: true, value: { ...base, type: "local_degraded", reason: input["reason"] } };
    }

    default:
      return fail(`unknown event type: ${JSON.stringify(input["type"])}`);
  }
}
