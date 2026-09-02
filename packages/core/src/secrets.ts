import type { HistoryStage } from "./extensions.ts";

/**
 * Secret redaction on outbound prompts (SPEC §5 Privacy).
 *
 * Runs as the *last* history stage, so whatever the other stages assemble is
 * scanned as it will actually be sent. Matches are replaced with a stable
 * placeholder rather than removed: the model still sees that a value was there
 * and what kind, which is usually enough to keep working.
 *
 * Patterns follow gitleaks' rule shapes for the credential types most likely to
 * appear in a repository: provider API keys, cloud credentials, private keys,
 * and generic `KEY=value` assignments with high-entropy values.
 */

export interface SecretPattern {
  readonly id: string;
  readonly pattern: RegExp;
}

/**
 * Ordered most-specific first, because a generic `token=` rule would otherwise
 * claim matches that a provider-specific rule names better in the audit log.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { id: "openrouter-key", pattern: /\bsk-or-v1-[0-9a-f]{32,}\b/g },
  { id: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g },
  { id: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { id: "slack-token", pattern: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g },
  { id: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "stripe-key", pattern: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}\b/g },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  {
    id: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    // KEY=value / key: "value" with a long high-entropy value. Deliberately last
    // and deliberately narrow: `password=hunter2` is the user's problem, but a
    // 40-character random string next to the word "secret" is a credential.
    id: "generic-secret",
    pattern:
      /\b(?:api[_-]?key|secret|token|password|passwd|auth)\b\s*[:=]\s*["']?([A-Za-z0-9+/_-]{32,})["']?/gi,
  },
];

export interface Redaction {
  readonly id: string;
  /** How many matches this rule replaced in the message. */
  readonly count: number;
}

const placeholder = (id: string): string => `[REDACTED:${id}]`;

/** Redacts secrets in one string, reporting what was found. */
export function redactSecrets(text: string): { text: string; redactions: Redaction[] } {
  let output = text;
  const redactions: Redaction[] = [];

  for (const { id, pattern } of SECRET_PATTERNS) {
    let count = 0;
    output = output.replace(pattern, (match, group?: string) => {
      count += 1;
      // For the generic rule keep the key name, redact only the value.
      if (id === "generic-secret" && typeof group === "string") {
        return match.replace(group, placeholder(id));
      }
      return placeholder(id);
    });
    if (count > 0) redactions.push({ id, count });
  }

  return { text: output, redactions };
}

interface TextPart {
  type: string;
  text?: string;
}

export interface SecretScannerOptions {
  /** Called once per message that had something redacted. */
  readonly onRedaction?: (event: { role: string; redactions: readonly Redaction[] }) => void;
}

/**
 * History stage that redacts every outbound message.
 *
 * Applies to all roles, including tool results: a `cat .env` is exactly how a
 * key ends up in a prompt, and the tool result is where it lands.
 */
export function createSecretScanner(options: SecretScannerOptions = {}): HistoryStage {
  return {
    name: "secret-scanner",
    async transform(messages) {
      return messages.map((message) => {
        const content = (message as { content?: unknown }).content;

        if (typeof content === "string") {
          const { text, redactions } = redactSecrets(content);
          if (redactions.length === 0) return message;
          options.onRedaction?.({ role: (message as { role: string }).role, redactions });
          return { ...message, content: text } as typeof message;
        }

        if (!Array.isArray(content)) return message;

        const all: Redaction[] = [];
        const parts = (content as TextPart[]).map((part) => {
          if (part.type !== "text" || typeof part.text !== "string") return part;
          const { text, redactions } = redactSecrets(part.text);
          all.push(...redactions);
          return redactions.length === 0 ? part : { ...part, text };
        });

        if (all.length === 0) return message;
        options.onRedaction?.({ role: (message as { role: string }).role, redactions: all });
        return { ...message, content: parts } as typeof message;
      });
    },
  };
}
