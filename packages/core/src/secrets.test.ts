import { describe, expect, it } from "vitest";
import { createSecretScanner, redactSecrets } from "./secrets.ts";

const HEX32 = "ff881dc39ddee48fa8c5f25a33b20800";

/**
 * Fixtures are assembled from parts so no scanner -- GitHub push protection
 * included -- reads a test file as a leaked credential. It did once.
 */
const join = (...parts: string[]) => parts.join("");

describe("redactSecrets", () => {
  it.each([
    ["openrouter-key", `key: sk-or-v1-${HEX32}${HEX32}`],
    ["anthropic-key", join("sk-ant-", "api03-abcdefghijklmnopqrstuvwxyz0123456789")],
    ["github-token", `token ghp_${"a".repeat(36)}`],
    ["aws-access-key", join("AKIA", "IOSFODNN7EXAMPLE")],
    ["slack-token", join("xoxb-", "1234567890-", "abcdefghijklmnop")],
    ["google-api-key", `AIza${"A".repeat(35)}`],
    ["stripe-key", `sk_live_${"x".repeat(24)}`],
    ["jwt", `eyJ${"a".repeat(20)}.eyJ${"b".repeat(20)}.${"c".repeat(20)}`],
  ])("redacts a %s", (id, text) => {
    const result = redactSecrets(`before ${text} after`);

    expect(result.text).toContain(`[REDACTED:${id}]`);
    expect(result.text).toContain("before");
    expect(result.text).toContain("after");
    expect(result.redactions.map((r) => r.id)).toContain(id);
  });

  it("redacts a private key block including its body", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----";
    const result = redactSecrets(`cat id_rsa\n${pem}\ndone`);

    expect(result.text).not.toContain("MIIEow");
    expect(result.text).toContain("[REDACTED:private-key]");
  });

  it("redacts only the value of a generic KEY=value, keeping the key name", () => {
    const value = "A".repeat(40);
    const result = redactSecrets(`API_KEY=${value}`);

    expect(result.text).toBe("API_KEY=[REDACTED:generic-secret]");
  });

  it("leaves short passwords alone, since that is the user's business", () => {
    expect(redactSecrets("password=hunter2").redactions).toEqual([]);
  });

  it("leaves ordinary code untouched", () => {
    const code = 'const token = parseToken(input);\nif (token.kind === "auth") return;';
    const result = redactSecrets(code);

    expect(result.text).toBe(code);
    expect(result.redactions).toEqual([]);
  });

  it("counts multiple matches of one rule", () => {
    const result = redactSecrets(
      `${join("AKIA", "IOSFODNN7EXAMPLE")} and ${join("AKIA", "I44QH8DHBEXAMPLE")}`,
    );

    expect(result.redactions).toEqual([{ id: "aws-access-key", count: 2 }]);
  });

  it("names the specific rule rather than the generic one when both match", () => {
    // The audit log is more useful saying "openrouter-key" than "generic".
    const result = redactSecrets(`OPENROUTER_API_KEY=sk-or-v1-${HEX32}${HEX32}`);

    expect(result.redactions[0]?.id).toBe("openrouter-key");
  });
});

describe("createSecretScanner", () => {
  const msg = (role: string, text: string) => ({ role, content: [{ type: "text", text }] });
  const textOf = (m: unknown) =>
    ((m as { content: { text?: string }[] }).content ?? []).map((p) => p.text ?? "").join("");

  it("redacts a key that arrived through a tool result", async () => {
    // `cat .env` is exactly how a key ends up in a prompt.
    const events: { role: string }[] = [];
    const stage = createSecretScanner({ onRedaction: (e) => events.push(e) });

    const out = await stage.transform([
      msg("user", "show me the env"),
      msg("toolResult", `OPENROUTER_API_KEY=sk-or-v1-${HEX32}${HEX32}`),
    ]);

    expect(textOf(out[1])).not.toContain(HEX32);
    expect(textOf(out[1])).toContain("[REDACTED:openrouter-key]");
    expect(events).toEqual([
      { role: "toolResult", redactions: [{ id: "openrouter-key", count: 1 }] },
    ]);
  });

  it("returns clean messages by identity, so a no-op costs no allocation", async () => {
    const stage = createSecretScanner();
    const input = [msg("user", "nothing secret here")];

    const out = await stage.transform(input);
    expect(out[0]).toBe(input[0]);
  });

  it("handles string content as well as parts", async () => {
    const stage = createSecretScanner();
    const out = await stage.transform([
      { role: "user", content: join("AKIA", "IOSFODNN7EXAMPLE") },
    ]);

    expect((out[0] as { content: string }).content).toBe("[REDACTED:aws-access-key]");
  });

  it("leaves image parts untouched", async () => {
    const stage = createSecretScanner();
    const image = {
      role: "toolResult",
      content: [{ type: "image", data: join("AKIA", "IOSFODNN7EXAMPLE") }],
    };

    const out = await stage.transform([image]);
    expect(out[0]).toBe(image);
  });
});
