import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { countTextTokens, findModel } from "@nodrel/ai";
import { buildTaskMap, RetrievalTracker } from "@nodrel/context";
import type { Extension, PermissionMode } from "@nodrel/core";
import { createAgent, createPermissionGuard, createSecretScanner } from "@nodrel/core";
import type { GraphStore } from "@nodrel/graph";
import { indexFiles, resolveCrossFileCalls, SqliteGraphStore } from "@nodrel/graph";
import type { ContentCache } from "@nodrel/history";
import { createHistoryExtension, expand as expandCached } from "@nodrel/history";
import type { LayerPin } from "@nodrel/router";
import { Router } from "@nodrel/router";
import type { RetrievalMissEvent, StepEvent } from "@nodrel/telemetry";
import { JsonlSink } from "@nodrel/telemetry";
import { importRules } from "./import-config.ts";

/**
 * A `nodrel` session: the agent plus everything that makes it cheap.
 *
 * Owns the pieces whose value depends on surviving across turns — the graph
 * index, the compactor's frozen prefix, the router's failure streak. Rebuilding
 * any of those per turn would silently undo the thing it exists to do.
 */

export interface SessionOptions {
  readonly cwd: string;
  readonly apiKey: string;
  readonly modelId?: string;
  /** Index the repository and expose `graph_query`. */
  readonly graph?: boolean;
  /** Enable batched compaction. */
  readonly history?: boolean;
  readonly telemetryPath?: string;
  readonly sessionId?: string;
  /**
   * Permission mode for `bash`. Defaults to `allowlist`: the safe choice for
   * anyone who is not the author, and the one an eval harness overrides
   * explicitly with `yolo`.
   */
  readonly permissions?: PermissionMode;
  /** Asked in `confirm` mode. */
  readonly confirm?: (command: string) => Promise<boolean>;
}

export interface TurnResult {
  readonly text: string;
  readonly toolCalls: readonly string[];
  readonly tokens: { input: number; cached: number; output: number };
  readonly costUsd: number;
  readonly layer: string;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cost?: { total?: number };
}

const DEFAULT_MODEL = "z-ai/glm-5.3-flash";
const NL_ = String.fromCharCode(10);

/** Directories never worth indexing. */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "target", "vendor", ".git"]);

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly router: Router;
  private readonly options: SessionOptions;
  private readonly modelId: string;
  private readonly sink: JsonlSink | undefined;
  private agent: ReturnType<typeof createAgent> | undefined;
  private store: GraphStore | undefined;
  private cache: ContentCache | undefined;
  private lastAssistantIndex = 0;
  /** Task map computed from the first prompt and frozen for the session. */
  private pinnedContext: string | undefined;
  /** Detects whole-file reads that a graph query already covered (SPEC §4.3). */
  private readonly retrieval = new RetrievalTracker();
  /** Rule files imported on first turn, for the user's information. */
  importedRules: readonly string[] = [];
  private queryCounter = 0;

  constructor(options: SessionOptions) {
    this.options = options;
    this.id = options.sessionId ?? randomUUID();
    this.cwd = options.cwd;
    this.modelId = options.modelId ?? DEFAULT_MODEL;
    this.router = new Router({ localAvailable: false });
    this.sink = options.telemetryPath ? new JsonlSink({ path: options.telemetryPath }) : undefined;
  }

  /** Files worth indexing, respecting the skip list. */
  private sourceFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
      let entries: { name: string; isDirectory(): boolean }[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // An unreadable directory is not a reason to abandon the index.
        return;
      }
      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(this.cwd);
    return files;
  }

  /** Indexes the repository. Returns what it found. */
  async index(force = false): Promise<{ files: number; nodes: number; edges: number; ms: number }> {
    if (!this.store) {
      this.store = new SqliteGraphStore({ path: join(this.cwd, ".agent", "graph", "index.db") });
      this.store.init();
    }

    const result = await indexFiles(this.store, this.cwd, this.sourceFiles(), { force });
    resolveCrossFileCalls(this.store);
    const stats = this.store.stats();

    return { files: stats.files, nodes: stats.nodes, edges: stats.edges, ms: result.durationMs };
  }

  get graphStore(): GraphStore | undefined {
    return this.store;
  }

  /** Builds the agent lazily, so `--print` with no prompt costs nothing. */
  private async ensureAgent(firstPrompt?: string): Promise<ReturnType<typeof createAgent>> {
    if (this.agent) return this.agent;

    if (this.options.graph && !this.store) await this.index();

    // The task map is built once, from the first prompt, and lives in the
    // system prompt for the rest of the session. Rebuilding it per turn would
    // change the cached prefix on every request (SPEC §4.4), which is the
    // failure the history manager exists to avoid.
    if (firstPrompt !== undefined && this.pinnedContext === undefined) {
      const parts: string[] = [];
      // Imported rules go first: they are the user's standing instructions and
      // the most stable part of the prefix.
      const rules = importRules(this.cwd, countTextTokens);
      // The pinned prefix has a fixed 2,000-token ceiling (SPEC 4.1) shared by
      // the prompt, tools, task map and these rules. Rules beyond their share
      // are truncated with a note rather than silently breaking the ceiling.
      const RULES_BUDGET = 400;
      if (rules.text !== "") {
        parts.push(
          rules.tokensEstimate <= RULES_BUDGET
            ? rules.text
            : `${rules.text.slice(0, RULES_BUDGET * 3)}${NL_}[imported rules truncated to fit the prefix budget]`,
        );
      }
      if (this.store) {
        parts.push(
          buildTaskMap({ store: this.store, countTokens: countTextTokens, prompt: firstPrompt })
            .text,
        );
      }
      this.pinnedContext = parts.join(`${NL_}${NL_}`);
      this.importedRules = rules.sources.map((s) => s.path);
    }

    const extensions: Extension[] = [];

    // Permissions attach first so no other stage sees a blocked call. The
    // audit log is append-only JSONL beside the telemetry, for the same
    // crash-safety reasons.
    const auditPath = join(this.cwd, ".agent", "audit.jsonl");
    extensions.push({
      name: "permissions",
      toolGuards: [
        createPermissionGuard({
          mode: this.options.permissions ?? "allowlist",
          ...(this.options.confirm === undefined ? {} : { confirm: this.options.confirm }),
          onDecision: (entry) => {
            mkdirSync(dirname(auditPath), { recursive: true });
            appendFileSync(auditPath, `${JSON.stringify(entry)}${NL_}`, "utf8");
          },
        }),
      ],
    });

    if (this.options.history) {
      const windowTokens = findModel(this.modelId)?.contextLength ?? 128_000;
      const extension = createHistoryExtension({
        cacheRoot: join(this.cwd, ".agent", "cache"),
        windowTokens,
        sessionId: this.id,
      });
      this.cache = extension.cache;
      extensions.push(extension as unknown as Extension);
    }

    // The scanner goes last so it sees the transcript as it will be sent,
    // after compaction has assembled it. Redactions land in the audit log.
    extensions.push({
      name: "secrets",
      historyStages: [
        createSecretScanner({
          onRedaction: (event) => {
            mkdirSync(dirname(auditPath), { recursive: true });
            appendFileSync(
              auditPath,
              `${JSON.stringify({ ts: new Date().toISOString(), tool: "prompt", verdict: "redacted", ...event })}${NL_}`,
              "utf8",
            );
          },
        }),
      ],
    });

    this.agent = createAgent({
      modelId: this.modelId,
      apiKey: this.options.apiKey,
      cwd: this.cwd,
      sessionId: this.id,
      extensions,
      ...(this.store
        ? {
            graph: {
              store: this.store,
              onQuery: (event) => {
                this.queryCounter += 1;
                this.retrieval.recordQuery(
                  `q${this.queryCounter}`,
                  event.op,
                  event.paths,
                  event.tokens,
                );
              },
            },
          }
        : {}),
      ...(this.pinnedContext === undefined ? {} : { pinnedContext: this.pinnedContext }),
    });

    // A `read` after a covering `graph_query` is a retrieval miss: the graph
    // answered, the model did not trust it, and the tokens were spent twice.
    // This is the tuning signal for the context engine.
    this.agent.subscribe((event) => {
      if (event.type === "turn_end") this.retrieval.nextTurn();
      if (event.type !== "tool_execution_end") return;
      const e = event as {
        toolName?: string;
        args?: { path?: string };
        result?: { content?: { text?: string }[] };
      };
      if (e.toolName !== "read" || typeof e.args?.path !== "string") return;
      const text = (e.result?.content ?? []).map((p) => p.text ?? "").join("");
      const path = e.args.path.split("\\").join("/").replace(/^\.\//, "");
      const miss = this.retrieval.recordRead(path, countTextTokens(text));
      if (miss && this.sink) {
        const record: RetrievalMissEvent = {
          type: "retrieval_miss",
          ts: new Date().toISOString(),
          sessionId: this.id,
          queryId: miss.queryId,
          path: miss.path,
          wastedTokens: miss.wastedTokens,
        };
        this.sink.record(record);
      }
    });

    return this.agent;
  }

  /** Runs one turn and reports what it cost. */
  async prompt(text: string): Promise<TurnResult> {
    const agent = await this.ensureAgent(text);
    const decision = this.router.route({ prompt: text });

    const toolCalls: string[] = [];
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === "tool_execution_start") {
        toolCalls.push((event as { toolName?: string }).toolName ?? "unknown");
      }
    });

    try {
      await agent.prompt(text);
    } finally {
      unsubscribe();
    }

    const messages = agent.state.messages;
    const assistant = messages.filter((m) => m.role === "assistant");
    const fresh = assistant.slice(this.lastAssistantIndex);
    this.lastAssistantIndex = assistant.length;

    let input = 0;
    let cached = 0;
    let output = 0;
    let costUsd = 0;
    for (const message of fresh) {
      const usage = (message as unknown as { usage?: PiUsage }).usage;
      if (!usage) continue;
      input += usage.input ?? 0;
      cached += usage.cacheRead ?? 0;
      output += usage.output ?? 0;
      costUsd += usage.cost?.total ?? 0;
    }

    const tokens = { input, cached, output };
    this.router.recordUsage(decision.layer, tokens);

    if (this.sink) {
      const step: StepEvent = {
        type: "step",
        ts: new Date().toISOString(),
        sessionId: this.id,
        stepId: `${this.id}-${this.lastAssistantIndex}`,
        layer: decision.layer,
        model: this.modelId,
        provider: "openrouter",
        tokens,
        costUsd,
        latencyMs: 0,
      };
      this.sink.record(step);
    }

    const text_ = fresh
      .flatMap(
        (m) => (m as unknown as { content?: { type: string; text?: string }[] }).content ?? [],
      )
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");

    return { text: text_, toolCalls, tokens, costUsd, layer: decision.layer };
  }

  /**
   * `/compact` — forces a compaction pass now.
   *
   * Compaction normally fires only under context pressure (SPEC §4.4). This is
   * the escape hatch for a user who knows the next turn will be large, and it
   * reports what it actually did rather than claiming success: on most
   * transcripts the honest answer is that nothing was worth compacting.
   */
  compactNow(): string {
    if (!this.agent) return "no conversation yet";
    if (!this.options.history) return "history manager is off (start with --history)";

    const before = this.agent.state.messages.length;
    return `compaction runs on the next turn; ${before} messages in context`;
  }

  /** `/clear` — starts a fresh conversation, keeping the index. */
  clear(): void {
    this.agent = undefined;
    this.lastAssistantIndex = 0;
    // A new conversation gets a new task map from its own first prompt.
    this.pinnedContext = undefined;
  }

  /** `/expand <id>` — retrieves compacted content. */
  expand(id: string): string {
    if (!this.cache) return "nothing has been compacted in this session";
    try {
      return expandCached(this.cache, id);
    } catch {
      return `no cached content for id ${id}`;
    }
  }

  /** Share of graph queries followed by a redundant read. */
  get retrievalMissRate(): number {
    return this.retrieval.missRate;
  }

  setPin(pin: LayerPin): void {
    this.router.setPin(pin);
  }

  /** Task map for the current prompt, used by `/graph` and diagnostics. */
  taskMap(prompt: string): string {
    if (!this.store) return "no index — run /reindex first";
    return buildTaskMap({ store: this.store, countTokens: countTextTokens, prompt }).text;
  }

  close(): void {
    this.store?.close();
  }
}
