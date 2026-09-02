import type { ToolGuard } from "./extensions.ts";

/**
 * Permission modes for `bash` (SPEC §5 Security).
 *
 * Attached through `beforeToolCall`, the hook ADR-002 verified for exactly this
 * purpose. The agent loop never sees the policy; it sees a blocked call with a
 * reason, which the model can read and route around.
 *
 * Three modes, matching what users of comparable tools expect:
 *
 * - `allowlist` — only commands matching an allow pattern run; everything else
 *   is blocked. The safe default for anyone who is not the author.
 * - `confirm` — commands outside the allow-list are put to an interactive
 *   prompt. Requires a `confirm` callback; without one, behaves as `allowlist`.
 * - `yolo` — everything runs. For eval harnesses and people who know.
 */

export type PermissionMode = "allowlist" | "confirm" | "yolo";

export interface PermissionPolicy {
  readonly mode: PermissionMode;
  /** Regexes a command must match to run without confirmation. */
  readonly allow?: readonly RegExp[];
  /** Regexes that are always blocked, even in `yolo`. */
  readonly deny?: readonly RegExp[];
  /** Asked in `confirm` mode. Return true to run. */
  readonly confirm?: (command: string) => Promise<boolean>;
  /** Every decision, for the audit log. */
  readonly onDecision?: (decision: AuditEntry) => void;
}

export interface AuditEntry {
  readonly ts: string;
  readonly tool: string;
  readonly command: string;
  readonly verdict: "allowed" | "blocked" | "confirmed" | "denied";
  readonly reason: string;
}

/**
 * Commands that are safe to run unprompted in any repository.
 *
 * Read-only or reversible by construction. Deliberately excludes `rm`, `git
 * push`, `curl | sh`, and package-manager installs — the things a mistaken
 * agent does that a user cannot undo.
 */
export const DEFAULT_ALLOW: readonly RegExp[] = [
  /^(?:ls|dir|pwd|cat|head|tail|wc|grep|rg|find|echo|which|type)\b/,
  /^git (?:status|diff|log|show|branch|blame|stash list)\b/,
  /^(?:node|python3?|uv run|pnpm|npm|yarn|cargo|go) (?:test|run test|-m pytest|vitest|check|typecheck|lint|build)\b/,
  /^(?:pnpm|npm|yarn) (?:test|typecheck|lint|build)\b/,
  /^(?:tsc|vitest|jest|pytest|biome|eslint|prettier)\b/,
];

/**
 * Commands blocked in every mode, including `yolo`.
 *
 * These are not "dangerous" in the abstract; they are the specific shapes that
 * turn a mistaken agent into a lost afternoon.
 */
export const DEFAULT_DENY: readonly RegExp[] = [
  /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*\s+)?(?:\/|~|\$HOME)(?:\s|$)/, // rm -rf / or ~
  /\bgit\s+push\b.*--force\b/,
  /\bgit\s+(?:reset\s+--hard|clean\s+-[a-z]*f)/,
  /\bcurl\b[^|]*\|\s*(?:sh|bash)\b/,
  /\b(?:mkfs|dd\s+if=|:\(\)\s*\{)/,
];

/** Extracts the command string from a `bash` tool call's arguments. */
const commandOf = (args: unknown): string | undefined => {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  return typeof command === "string" ? command.trim() : undefined;
};

const matches = (patterns: readonly RegExp[] | undefined, command: string): boolean =>
  (patterns ?? []).some((pattern) => pattern.test(command));

/** Builds the `beforeToolCall` guard that enforces a policy on `bash`. */
export function createPermissionGuard(policy: PermissionPolicy): ToolGuard {
  const audit = (entry: Omit<AuditEntry, "ts">): void =>
    policy.onDecision?.({ ts: new Date().toISOString(), ...entry });

  return {
    name: `permissions:${policy.mode}`,
    async check(context) {
      const toolName = (context as { toolCall?: { name?: string } }).toolCall?.name ?? "";
      if (toolName !== "bash") return undefined;

      const args = (context as { toolCall?: { arguments?: unknown } }).toolCall?.arguments;
      const command = commandOf(args);
      if (command === undefined) {
        return { block: true, reason: "bash call has no command" };
      }

      // The deny list wins over everything, including yolo. A user who wants to
      // run `rm -rf ~` can do it in their own shell.
      if (matches(policy.deny ?? DEFAULT_DENY, command)) {
        audit({ tool: toolName, command, verdict: "blocked", reason: "matches deny list" });
        return { block: true, reason: `blocked by policy: ${command.slice(0, 80)}` };
      }

      if (policy.mode === "yolo") {
        audit({ tool: toolName, command, verdict: "allowed", reason: "yolo mode" });
        return undefined;
      }

      if (matches(policy.allow ?? DEFAULT_ALLOW, command)) {
        audit({ tool: toolName, command, verdict: "allowed", reason: "matches allow list" });
        return undefined;
      }

      if (policy.mode === "confirm" && policy.confirm) {
        const approved = await policy.confirm(command);
        audit({
          tool: toolName,
          command,
          verdict: approved ? "confirmed" : "denied",
          reason: "interactive confirmation",
        });
        return approved
          ? undefined
          : { block: true, reason: `user declined: ${command.slice(0, 80)}` };
      }

      audit({ tool: toolName, command, verdict: "blocked", reason: "not on allow list" });
      return {
        block: true,
        reason:
          `command not on the allow list: ${command.slice(0, 80)}. ` +
          "Use a read-only or test command, or ask the user to run it.",
      };
    },
  };
}
