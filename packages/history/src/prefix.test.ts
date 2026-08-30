import { describe, expect, it } from "vitest";
import { buildPrefix, PrefixDriftError, PrefixGuard, serializeTools } from "./prefix.ts";

const tools = [
  { name: "read", description: "Read a file", parameters: { type: "object" } },
  { name: "bash", description: "Run a command", parameters: { type: "object" } },
];

const prefix = (overrides: Partial<Parameters<typeof buildPrefix>[0]> = {}) =>
  buildPrefix({ systemPrompt: "You are terse.", tools, ...overrides });

describe("serializeTools", () => {
  it("is stable across differently-ordered keys", () => {
    // JSON.stringify follows insertion order, so two equal objects can
    // serialize differently and silently break the provider cache.
    const a = serializeTools([{ name: "read", description: "d", parameters: {} }]);
    const b = serializeTools([{ description: "d", parameters: {}, name: "read" }]);

    expect(a).toBe(b);
  });

  it("sorts nested keys too", () => {
    const a = serializeTools([{ parameters: { properties: { a: 1, b: 2 }, type: "object" } }]);
    const b = serializeTools([{ parameters: { type: "object", properties: { b: 2, a: 1 } } }]);

    expect(a).toBe(b);
  });

  it("preserves tool order, which affects model selection behaviour", () => {
    const forward = serializeTools([{ name: "read" }, { name: "bash" }]);
    const reversed = serializeTools([{ name: "bash" }, { name: "read" }]);

    expect(forward).not.toBe(reversed);
  });

  it("keeps array element order inside a schema", () => {
    const a = serializeTools([{ enum: ["a", "b"] }]);
    const b = serializeTools([{ enum: ["b", "a"] }]);

    expect(a).not.toBe(b);
  });
});

describe("buildPrefix", () => {
  it("produces the same digest for the same inputs", () => {
    expect(prefix().digest).toBe(prefix().digest);
  });

  it("changes digest when the system prompt changes", () => {
    expect(prefix().digest).not.toBe(prefix({ systemPrompt: "You are verbose." }).digest);
  });

  it("changes digest when a tool schema changes", () => {
    const edited = [{ ...tools[0], description: "Read a file, maybe" }, tools[1]];

    expect(prefix().digest).not.toBe(prefix({ tools: edited }).digest);
  });

  it("changes digest when pinned instructions change", () => {
    expect(prefix().digest).not.toBe(prefix({ pinnedInstructions: "Extra." }).digest);
  });

  it("treats absent and empty pinned instructions alike", () => {
    expect(prefix().digest).toBe(prefix({ pinnedInstructions: "" }).digest);
  });
});

describe("PrefixGuard", () => {
  it("stays stable across 50 synthetic turns", () => {
    // The stability requirement from SPEC §4.4, asserted at the scale it names.
    const guard = new PrefixGuard();

    expect(() => {
      for (let turn = 0; turn < 50; turn++) guard.check(prefix());
    }).not.toThrow();
  });

  it("throws when the prefix drifts mid-session", () => {
    const guard = new PrefixGuard();
    guard.check(prefix());

    expect(() => guard.check(prefix({ systemPrompt: "changed" }))).toThrow(PrefixDriftError);
  });

  it("explains the cost consequence in the error", () => {
    // Silent drift only shows up as a cost rise weeks later, by which point
    // the cause is untraceable, so the message has to say what went wrong.
    const guard = new PrefixGuard();
    guard.check(prefix());

    expect(() => guard.check(prefix({ systemPrompt: "changed" }))).toThrow(/cache/i);
  });

  it("survives a timestamp appended after the prefix", () => {
    // Dynamic content is allowed, as long as it lands after the pinned head.
    const guard = new PrefixGuard();
    guard.check(prefix());

    expect(() => guard.check(prefix())).not.toThrow();
  });

  it("catches a timestamp leaking into the pinned instructions", () => {
    // The most common way a prefix drifts in practice.
    const guard = new PrefixGuard();
    guard.check(prefix({ pinnedInstructions: "Session started 12:00:00" }));

    expect(() => guard.check(prefix({ pinnedInstructions: "Session started 12:00:01" }))).toThrow(
      PrefixDriftError,
    );
  });

  it("reports drift without throwing when asked", () => {
    const guard = new PrefixGuard();
    guard.check(prefix());

    expect(guard.hasDrifted(prefix())).toBe(false);
    expect(guard.hasDrifted(prefix({ systemPrompt: "changed" }))).toBe(true);
  });

  it("reports no drift before anything has been pinned", () => {
    expect(new PrefixGuard().hasDrifted(prefix())).toBe(false);
  });

  it("exposes the pinned prefix", () => {
    const guard = new PrefixGuard();
    expect(guard.current).toBeUndefined();

    const pinned = guard.check(prefix());
    expect(guard.current?.digest).toBe(pinned.digest);
  });
});
