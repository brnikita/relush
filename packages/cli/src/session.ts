import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { countTextTokens, findModel } from "@nodrel/ai";
import { buildTaskMap } from "@nodrel/context";
import type { Extension } from "@nodrel/core";
import { createAgent } from "@nodrel/core";
import type { GraphStore } from "@nodrel/graph";
import { indexFiles, resolveCrossFileCalls, SqliteGraphStore } from "@nodrel/graph";
import type { ContentCache } from "@nodrel/history";
import { createHistoryExtension, expand as expandCached } from "@nodrel/history";
import type { LayerPin } from "@nodrel/router";
import { Router } from "@nodrel/router";
import type { StepEvent } from "@nodrel/telemetry";
import { JsonlSink } from "@nodrel/telemetry";

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
  private async ensureAgent(): Promise<ReturnType<typeof createAgent>> {
    if (this.agent) return this.agent;

    if (this.options.graph && !this.store) await this.index();

    const extensions: Extension[] = [];
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

    this.agent = createAgent({
      modelId: this.modelId,
      apiKey: this.options.apiKey,
      cwd: this.cwd,
      sessionId: this.id,
      extensions,
      ...(this.store ? { graph: { store: this.store } } : {}),
    });

    return this.agent;
  }

  /** Runs one turn and reports what it cost. */
  async prompt(text: string): Promise<TurnResult> {
    const agent = await this.ensureAgent();
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
