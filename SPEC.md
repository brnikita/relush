# Technical Specification: Token-Optimized Coding Agent CLI

Version 2.0 — 2026-08-31
Supersedes v1.0 (2026-08-30). Every change is justified by a measurement or a
verified external fact; §0.1 lists them.
Audience: **an autonomous coding agent (Claude Code)** executing this spec, plus
human reviewers.
Working name: `nodrel`.

---

## 0. How to use this document

1. Execute phases **in order** (P0 → P5). A phase is DONE only when its verify
   command exits 0 and its gate table is met.
2. Where this spec leaves a choice open, take the **Default** column and log an
   ADR in `docs/decisions/`. Do not ask for confirmation.
3. Never commit secrets. Keys come only from the env vars in §10.
4. TypeScript strict mode, Node ≥ 22, pnpm. Eval harness in Python via `uv`.
5. Write tests with the implementation. Every commit: `pnpm typecheck && pnpm
   lint && pnpm test` green.
6. `pnpm check:budgets` must never be disabled or weakened (§4.1).
7. **A gate that fails on merit produces `docs/decisions/DEVIATION-<n>.md` and
   stops the phase.** It is never quietly lowered.

### 0.1 What changed from v1.0, and why

v1.0 was written before any code existed. Building P0–P2 and measuring it
invalidated six of its assumptions.

| v1.0 said | Reality | Evidence |
|---|---|---|
| Fork `badlogic/pi-mono`, 4 packages | Repo is `earendil-works/pi`, 10 scoped packages, npm workspaces | Verified 2026-08-30 |
| Kùzu is the default graph DB | **Kùzu was acquired by Apple (Oct 2025) and archived**; npm package deprecated | Repo `archived: true`, last release v0.11.3 |
| XXH3 for content hashing | BLAKE2b in `node:crypto` is fast enough by 700× margin | 84 ms / 50 MB vs a 60 s budget |
| Masking is a free win | **Masking as specified is a design error**: its threshold was 3 orders of magnitude below break-even | Arithmetic, DEVIATION-002 |
| — | **Two tasks × one seed cannot measure a 10% effect**: identical runs vary 26% in cost | Measured; a claim was withdrawn over this |
| Cheapest model per token wins | `ling-3.0-flash` is 3.6× cheaper and solves **nothing** in 200 s | Measured |
| tree-sitter native bindings | `web-tree-sitter` (WASM) removes the last native dependency | Verified parsing |

The masking result is the significant one. It is not a bug in the
implementation; it is a flaw in v1.0's design, and §4.4 is rewritten around it.

The measurement result is the humbling one. An earlier revision of this document
cited a 14.9% cost regression from masking. That figure came from a single-seed
comparison whose run-to-run noise is 26%, and it has been **withdrawn**. The
design conclusion stands because it rests on arithmetic rather than on that
measurement, but §9's methodology rules exist because this project has already
made the mistake once.

---

## 1. Product summary

A terminal coding agent equivalent in workflow to Claude Code, designed to
minimize token consumption and latency:

- Harness overhead (system prompt + core tools) ≤ 2,000 tokens per request.
  **Currently 841.**
- A local **code graph** replaces whole-file reads with budgeted structural
  retrieval.
- **Cache-first history management**: the transcript is append-only by default;
  compaction happens in batches at stable boundaries, never per turn.
- **Model routing** across three layers: local → cheap cloud → escalation.
- A stable prompt prefix to maximize provider cache hits.

Economic target: blended cost ≤ ~$0.10 per 1M tokens with escalation ≤ 15% of
tokens. **Measured baseline is already $0.023/M blended** (§7 P1), so the
binding constraint is tokens per *solved task*, not price per token.

### 1.1 Foundation

Built on **Pi** (`earendil-works/pi`, MIT, v0.84.4, actively maintained) as a
**dependency, not a fork** (ADR-002). nodrel's packages attach through Pi's
documented `AgentOptions` hooks:

| nodrel need | Pi hook | Verified capability |
|---|---|---|
| Masking, compaction, prefix pinning | `transformContext` | Rewrites messages before each request |
| Tool-output compression | `afterToolCall` | Replaces result content in full |
| Tool interception | `beforeToolCall` | Returns `{ block, reason }` |
| **Per-step layer selection** | `prepareNextTurnWithContext` | `AgentLoopTurnUpdate.model` |
| Telemetry | `subscribe`, `onResponse` | Lifecycle events with usage |

Pi also supplies `read`/`write`/`edit`/`bash` implementations and a built-in
`openrouter` provider whose `streamSimple` matches its own `StreamFn`. This is
why P0 required one adapter rather than a fork.

### 1.2 Research this design encodes

Do not re-litigate these.

- **Observation masking** matches LLM-summarization quality at zero extra
  compute; summaries lengthen trajectories 13–15% by hiding failure signals
  (JetBrains, SWE-bench Verified). **Confirmed locally**: masking cost no
  quality (100% solve rate both ways) and no extra turns (15.5 both ways).
- **Compaction invalidates prefix caches.** Pruning and eviction mutate the
  sequence and cause prefix mismatch; the fix is stabilizing prefixes at
  ingestion and evicting on a conservative batch schedule, not per turn
  (TokenPilot, arXiv 2606.17016 — 61%/87% cost reduction). **Independently
  rediscovered here before the paper was found**; §4.4 follows its principle.
- **Append-only ordering.** Any modification to earlier content invalidates the
  cache from that point on. Order content most-stable to least-stable, with
  dynamic data last.
- **Tree-sitter code graph over MCP**: ~10× fewer tokens, 2.1× fewer tool calls,
  ~9pp answer-quality cost. Graph retrieval must be budgeted and
  expandable-on-demand to claw the quality back.
- **Tool-description overhead**: filtering 29 tools to a relevant subset cut
  description tokens 82% and selection errors 89%.
- **Model routing 70/20/10** ≈ 25–30% of all-frontier cost.

---

## 2. Scope

**In scope (v1):** CLI harness (TUI, `--print/--json`, RPC, SDK); graph indexer
and context engine; cache-first history manager; router; local-model runtime;
telemetry; eval harness; installer.

**Out of scope (v1):** web UI, team features, model hosting, IDE plugins beyond
RPC, the billing backend (client hooks only).

---

## 3. Architecture

```
┌────────────────────────── user machine ───────────────────────────┐
│  CLI / TUI / RPC / SDK                                            │
│        │                                                          │
│  Pi Agent Loop ── hooks ──┬─ Context Engine ── GraphStore (SQLite) │
│        │                  ├─ History Manager (cache-first)        │
│        │                  ├─ Tool Layer (5 core + lazy skills)    │
│        │                  └─ Telemetry (JSONL, per-step cost)     │
│        ▼                                                          │
│  Router ──► Local Runtime (Ollama)                                │
│        └──► OpenRouter ──► flash (default) / escalation / BYOK    │
└───────────────────────────────────────────────────────────────────┘
```

Monorepo (pnpm workspaces), nine packages, all present:

```
packages/
  core/       # hook composition, system prompt, tool schemas, agent assembly
  ai/         # provider client, tokenizer, cost tables
  cli/        # TUI, slash commands, task runner
  graph/      # web-tree-sitter indexer + SQLite GraphStore
  context/    # budgeted retrieval, task map
  history/    # content cache, batched compaction, prefix pinning
  router/     # layer selection, fallbacks, budget accounting
  local/      # hardware detection, Ollama adapter
  telemetry/  # event schema, JSONL sink, aggregation
eval/         # Python harness (uv), task suites, reports
docs/decisions/
```

### 3.1 Per-step data flow

1. Router classifies the step (rules + session signals; §8).
2. Context Engine builds a task map within budget. No LLM call.
3. History Manager assembles messages **append-only**; compaction runs only when
   §4.4's trigger fires.
4. Tool Layer exposes 5 core tools + top-k relevant skills.
5. Request goes to the selected layer; usage, cost and latency are logged.
6. Failure signals update router state; two consecutive failures escalate.

---

## 4. Component requirements

### 4.1 Harness core

- Core system prompt ≤ **800 tokens**. Total fixed overhead (prompt + core tool
  schemas + pinned instructions) ≤ **2,000 tokens**, enforced by
  `scripts/check-budgets.ts`. **Current: 331 and 841.**
- Default tools: `read`, `write`, `edit`, `bash`, `graph_query`. Everything else
  is a lazily-loaded skill.
- Modes: interactive TUI; `--print`/`--json`; `--rpc`; importable SDK.
- Slash commands: `/cost`, `/model`, `/fast`, `/strong`, `/compact`,
  `/expand <id>`, `/graph <query>`, `/reindex`.
- On first run, import rules and skills from `.claude/`, `.cursor/`, `.codex/`,
  `.cline/` if present. Read-only.
- Output style terse: explanations ≤ 3 sentences unless asked. Target ≥ 40%
  output-token reduction versus un-instructed baseline.

### 4.2 Graph indexer and store

- **Parsers: `web-tree-sitter` (WASM).** Grammar packages ship prebuilt `.wasm`,
  so no compiler is required. ≥ 15 languages at v1.
- **Store: SQLite via `node:sqlite`** (built into Node 22+), behind a
  `GraphStore` interface with a conformance suite. **Kùzu is removed** — the
  project was acquired by Apple in October 2025 and archived, and the only
  active fork (`ryugraph`) has 143 stars, no commits since January 2026, and the
  same native build requirements. Depending on either is unacceptable for a core
  component. See ADR-001.
- **The project has no native dependencies.** This is a hard property, not an
  accident: it is what lets nodrel build on Windows, macOS and Linux without a
  C++ toolchain. Any proposed dependency requiring `node-gyp` or `cmake-js`
  needs an ADR arguing why the portability loss is worth it.
- Node types: `file, module, class, function, method, type, test, commit`.
  Edges: `imports, calls, references, inherits, implements, tests, modified_in,
  co_changed_with`.
- Content hashing: **BLAKE2b** from `node:crypto`, truncated to 128 bits
  (ADR-003).
- Incremental indexing: content hashes + git diff + fs watcher. Incremental
  ≥ 4× faster than full.
- Graph traversal uses recursive CTEs. `impact(diff)` and transitive
  `references` are the queries most at risk of missing the p95 gate; benchmark
  them first.
- Enrichment (background, local model only, skippable): one-line description and
  embedding per symbol. **Never call a cloud model for enrichment.** Without a
  local model, `search` degrades to identifier matching.
- Performance gates: full index of 1M LOC ≤ 60 s; incremental ≤ 5 s; query
  p95 ≤ 100 ms, on the pinned corpus.
- Also expose the graph as an MCP server.

### 4.3 Context engine

- `graph_query` operations: `overview(path)`, `symbol(name, depth)`,
  `references(name)`, `dependencies(name)`, `impact(diff)`, `tests_for(name)`,
  `search(nl_query, k)`, `expand(id)`.
- **Every response is token-budgeted** (default 4,000). Over budget, rank by
  relevance and proximity to the current focus; return the tail as opaque ids.
- Responses are compressed signatures — name, params, types, first docstring
  line. **Never bodies.** A body is a separate explicit fetch.
- **Task map**: before the first model call, deterministically assemble a
  repo-map plus top-k matching nodes. No LLM call. Byte-identical for identical
  input, because it is part of the pinned prefix (§4.4).
- Retrieval-miss logging: if the model reads a whole file after a `graph_query`
  covering it, emit `retrieval_miss`.

### 4.4 History manager — cache-first

**This section is rewritten. v1.0's design is measurably a cost regression.**

#### The problem

Providers cache on exact prefix match. Modifying any message invalidates the
cache for that message and everything after it. On every model in the
OpenRouter catalogue the cached rate is exactly **0.2× the fresh rate**, so a
cache miss on a suffix of `S` tokens costs `0.8 × S` extra.

Masking a message of `T` tokens saves `(T − 25)` tokens, but only at the cached
rate on subsequent requests. Break-even per masking event, with `R` subsequent
requests before the next invalidation:

```
(T − 25) × 0.2 × R  ≥  S × 0.8
```

v1.0's sliding 6-turn window re-masks on **every turn**, so `R = 1` and the
threshold becomes `T ≥ 4S + 25`. With a 10,000-token suffix an output would have
to exceed 40,000 tokens to pay for itself. v1.0 set the threshold at 50 tokens —
three orders of magnitude too low.

Measured consequence (`longhorizon` suite, identical tasks):

| | masking off | masking on |
|---|---|---|
| tokens/task | 32,148 | 29,140 (−9.4%) |
| cache hit | 93.8% | 83.2% |
| **cost/task** | **$0.00074** | **$0.00085 (+14.9%)** |

#### The design

**Rule 1 — Append-only by default.** The transcript is never rewritten in the
ordinary path. Content is ordered most-stable to least-stable: system prompt,
tool schemas, task map, then conversation.

**Rule 2 — Compaction is batched, not continuous, and has two modes.**

Working the break-even forward with real numbers settles what compaction is
*for*. At `R = 20` with a 20,000-token suffix an output must exceed ~4,000
tokens to pay for itself; measured tool outputs average **~160 tokens**.
**Compaction is therefore not a cost optimization on this workload, and batching
does not rescue it** — batching lowers the bar by the factor `R`, not by the
factor of ~25 that would be needed.

It remains necessary for a different reason: the window is finite, and near the
limit the alternative to compacting is a request that does not fit. Hence:

- **Opportunistic** — above 60% of the window. Compact only what clears
  break-even. On typical workloads that is nothing, and nothing is correct.
- **Mandatory** — above 85% of the window. Compact largest-first until the
  transcript fits, break-even notwithstanding, because feasibility outranks
  cost.

**Rule 3 — Size threshold from the break-even, not a constant.** In
opportunistic mode an output is compacted only if `T ≥ 4S / R_expected`, where
`S` is the suffix it would invalidate. Implementations compute this; they do not
hardcode it. `R_expected` is deliberately conservative — underestimating merely
forgoes a saving, overestimating ships v1.0's regression.

**Rule 3a — Compacted regions are frozen.** Once compacted, a region is never
recomputed; its bytes are memoized and replayed verbatim, so the cache re-warms
after a single miss. A batched compactor that recomputed its output each turn
would be exactly as bad as a sliding window.

**Rule 4 — Compaction is reversible.** Originals are stored content-addressed
in `.agent/cache/`, retrievable via `expand(id)` byte-identically. Content is
held as bytes, never as decoded strings.

**Rule 5 — Failure signals survive verbatim.** Failed tests, stack traces and
error output are never compacted away, whatever their size. This is what makes
masking safer than summarization; discarding it discards the reason for the
choice.

**Rule 6 — Prefix pinning.** System prompt, tool schemas and task map are
byte-stable for the whole session. Tool schemas serialize with sorted keys, since
`JSON.stringify` follows insertion order. A CI test asserts stability across 50
synthetic turns.

**Tool-output compression** before insertion: AST-aware for code (drop bodies of
unchanged functions), structural for JSON, line-scored for logs. **No
token-level pruning** — it breaks code syntax. Compression at ingestion is
preferred over compaction later, because it never invalidates a cache.

**Gate**: compaction is held to feasibility and safety, not to cost, because
the arithmetic above shows cost is not what it can deliver:

1. Append-only below the pressure threshold.
2. Frozen regions replay byte-identically across turns.
3. Failure signals preserved verbatim in both modes.
4. A session that would overflow a small window still completes, with no
   solve-rate loss.
5. **No cost regression outside the measured noise floor.**

Cost per solved task is a **P3** gate, owned by the context engine. Attacking
tokens before they enter the transcript has no cache to lose, which is why that
is where the saving actually lives.

### 4.5 Router

- Layers: `local` (hardware-dependent), `flash` (default cloud),
  `escalation`, `byok`.
- Decision inputs: rule-based task class, `impact()` size, session failure
  state, explicit `/fast` / `/strong`, remaining budget.
- Local-by-default steps: graph enrichment, summarization, commit messages,
  templated test generation, single-symbol edits with existing tests.
- Escalation triggers: two consecutive failed verification runs; `impact()` > 12
  files; explicit `/strong`. De-escalate after two consecutive green steps.
- Fallbacks: retry the same model twice with backoff, then move to the next in
  the chain. Fall back on 429, 408, 5xx, timeouts and **model-specific 400s**
  (an unknown model id is model-specific; a malformed body is not). Never fall
  back on 401.
- Budget accounting: 5-hour rolling window plus weekly cap. **Local tokens do
  not count.**
- Hard invariant, CI-tested: escalation ≤ **15% of tokens** over the eval suite.

### 4.6 Local runtime

- Hardware detection → profile: < 16 GB VRAM → cloud-only; 16 GB →
  `gpt-oss-20b`; 24 GB → `qwen3.6-35b-a3b`; 64 GB → `qwen3-coder-next-80b-a3b`.
- Backends: Ollama (Default), llama.cpp, MLX, registered as an
  OpenAI-compatible provider with `cost: 0`.
- Graceful degradation: local unavailable ⇒ route to flash, emit
  `local_degraded`, do not interrupt the session.
- **The reference machine has 12 GB VRAM and cannot host the 24 GB profile.**
  The local layer is developed against a simulated profile and every report is
  stamped `hardware: simulated`. The §6 local-share KPI is **not claimable**
  here and requires a 24 GB machine.

### 4.7 Tool layer

- Semantic skill selection: local embeddings over skill descriptions, top-k = 5
  per step. Unselected skills appear as one-line stubs.
- LSP operations: rename via `workspace/willRenameFiles`, post-edit diagnostics,
  go-to-definition for strong-LSP languages.
- Test runner tool: detects the framework, runs targeted tests from
  `tests_for()`, returns structured pass/fail to the router.

### 4.8 Provider layer

- Default provider OpenRouter; BYOK keys in the OS keychain.
- Usage split: `prompt_tokens` is **inclusive of cached tokens**. Store them
  separately or the cache-hit KPI is unmeasurable and cached tokens are
  overcharged.
- **Reasoning models spend the completion budget before answering.** Results
  must carry `reasoning`, `finishReason` and reasoning token counts; a truncated
  response is a budget problem, not a wrong answer, and must be distinguishable
  from one.
- Gateway client (P5): device-token auth, usage sync, price refresh, non-blocking
  with a 500 ms budget; offline ⇒ cached limits and local-only or BYOK.

### 4.9 Telemetry and eval

- Event schema (JSONL, local, opt-in aggregate upload): step id, layer, model,
  provider, tokens (fresh/cached/output), cost, latency, verification result,
  retrieval misses, compaction events.
- Writes are synchronous and append-only; reads tolerate a torn trailing line
  from a crash.
- **Eval measures cost per solved task, and per-task wall time.** Price per
  token is not a metric: `ling-3.0-flash` is 3.6× cheaper per token than the
  default and failed to solve a one-line bug in 200 s, where the default
  succeeded in 18 s.
- Every task carries a verification command whose exit status decides the
  outcome. **No model judges its own work.** A task that edits the test instead
  of the source fails.
- Suites: `smoke` (5 tasks, fast), `internal` (≥ 30 tasks), `longhorizon`
  (≥ 10 tasks of ≥ 15 turns), `swebench` (Verified-50, Docker).
- **`longhorizon` is mandatory for any history-manager claim.** Short tasks
  cannot exercise compaction: the `internal` suite averages 5.1 turns and the
  history manager never engaged on it.
- Multi-seed runs report mean ± sd **for cost, tokens and cache hit**, not only
  solve rate. Three seeds minimum for a frozen report.
- **A difference smaller than the pooled spread is not an effect** and is
  reported as "within noise". The measured run-to-run spread on a two-task,
  single-seed comparison was 26% of cost — larger than most effects worth
  claiming. `eval:compare` enforces this labelling.
- The runner must not report success when the model produced no usable output.
  A run with zero tokens and zero tool calls is a failure regardless of whether
  an exception was thrown.

---

## 5. Non-functional requirements

| Area | Requirement |
|---|---|
| Privacy | Source never leaves the machine except prompt fragments for a step. Graph, embeddings and caches stay local. A secret scanner runs on every outbound prompt; matches are redacted and logged. |
| Portability | **No native dependencies.** macOS, Linux, and Windows natively. POSIX shell scripts are exercised on CI runners. |
| Speed | Cold start on an indexed repo ≤ 2 s; graph query p95 ≤ 100 ms; harness-added TTFT overhead ≤ 150 ms. |
| Reliability | Survive any provider outage without losing the session; crash-safe state, resumable after `kill -9` mid-tool-call. |
| Licensing | Core MIT. Dependencies MIT/Apache-2. No AGPL in distributed binaries. **No archived or deprecated dependencies in the core path.** |
| Security | `bash` behind allow-list or confirmation; tool-call audit log; no `eval` of remote code without opt-in. |

---

## 6. KPIs

Measured by `eval/`, against the frozen P1 baseline.

| Metric | Target | Gate |
|---|---|---|
| **Cost per solved task** (`longhorizon`) | ≤ 50% of baseline | P2 |
| Tokens per solved task (`internal`) | ≤ 35% of baseline | P3 |
| Solve rate | ≥ 95% of baseline | every phase |
| Escalation share of tokens | ≤ 15% | P4 |
| Fixed prompt overhead | ≤ 2,000 tokens | every CI run |
| Provider cache-hit rate | ≥ 90% of input tokens | P2 |
| Local-layer token share (24 GB profile) | ≥ 30% | P4, simulated |
| Full index 1M LOC / incremental / query p95 | ≤ 60 s / ≤ 5 s / ≤ 100 ms | P3 |
| Output tokens vs un-instructed | −40% | P2 |

Two targets are raised from v1.0 because the baseline already beats them:
cache-hit (75% → 90%, measured 88.4%) and the headline economic metric, which
moves from tokens to **cost per solved task** — the masking result showed those
can move in opposite directions.

---

## 7. Phases

### P0 — Foundation ✅ DONE

Workspace, strict TypeScript, Biome, Vitest, CI, MIT licence, nine packages,
Pi integration through hooks, runnable agent.
Verify: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`

### P1 — Measurement ✅ DONE

Telemetry schema and sink, tokenizer calibrated to within 2% of provider usage,
cost tables, budget checker, provider client with fallback chain, `/cost`, eval
harness, frozen baseline.

Baseline (`internal`, 8 tasks × 3 seeds, `z-ai/glm-5.3-flash`):
solve rate 100%, 7,189 tokens/task, $0.00025/task, 88.4% cache hit, 5.0 turns.
`longhorizon` (2 tasks): 32,148 tokens/task, $0.00074/task, 93.8% cache, 15.5 turns.

Verify: `pnpm eval:baseline && pnpm test`

### P2 — Cache-first history manager ✅ DONE

Batched two-mode compaction, frozen regions, failure-signal preservation,
prefix pinning, and variance reporting in the eval harness.

Outcome: compaction is a **feasibility mechanism**, not a cost lever. On typical
workloads it correctly declines to act. See DEVIATION-002 for the arithmetic and
for the withdrawn cost claim.

Remaining for P2: ingestion-time compression per content type, and the terse
output instruction (§4.1), both of which reduce tokens *before* they enter the
transcript and so cost no cache.

**Gate**: the five conditions in §4.4. Cost per solved task moves to P3.
Verify: `pnpm test && pnpm check:budgets`

### P3 — Graph indexer and context engine ⬅ CURRENT

Tasks: `GraphStore` interface and conformance suite; SQLite implementation;
`web-tree-sitter` indexer (TS/JS first, then 15 languages); incremental
indexing; `graph_query` with budgets and `expand`; task map; retrieval-miss
logging; `bench:graph`; MCP server. SCIP indexers for ts/py/go where available.

**Gate**: §4.2 performance table met; **cost per solved task ≤ 50% of
baseline** (inherited from P2); tokens per solved task ≤ 35% of baseline; solve
rate ≥ 95% of baseline. All differences reported with spread; anything inside
the noise floor is not an effect.
Verify: `pnpm bench:graph && pnpm eval:compare --against p1`

### P4 — Router and local runtime

Tasks: rule classifier plus a labelled 500-prompt set; layer config with health
checks; escalation state machine; budget accounting; Ollama adapter and hardware
detection; `/fast`, `/strong`, `/model`; layer badge in the TUI.

**Gate**: KPI rows 1–4 met. Report stamped `hardware: simulated` (§4.6).
Verify: `pnpm eval:full --against p1`

### P5 — Gateway, installer, hardening

Tasks: device-token auth; usage windows; BYOK via keychain; `curl | sh`
installer with per-platform binaries; offline mode; secret scanner; crash
recovery; config import; docs; final report.

**Gate**: all §6 KPIs met; zero P0/P1 bugs; `eval/reports/v1.json` committed.
Verify: `pnpm eval:full --against p1 && pnpm test:all && scripts/install-e2e.sh`

---

## 8. Defaults for open questions

| Question | Default | Revisit trigger |
|---|---|---|
| Graph store | SQLite via `node:sqlite`, sole implementation | Misses a §4.2 gate → evaluate a *maintained* graph engine, ADR required |
| Parser runtime | `web-tree-sitter` (WASM) | A language with no prebuilt `.wasm` grammar |
| Content hash | BLAKE2b (`node:crypto`) | Hashing shows as material in `bench:graph` → `xxhash-wasm` |
| Default model | `z-ai/glm-5.3-flash` ($0.075/$0.25/M) | A model beats it on **cost per solved task**, not per token |
| Escalation model | `z-ai/glm-5.3`; evaluate `minimax/minimax-m3` ($0.30/$1.20, 4.7× cheaper) | P4 measurement |
| Compaction trigger | 60% of window, batched | P2 measurement |
| Task-map format | repo-map + top-k hybrid | Pure top-k within 2% tokens → simplify |
| Dev platform | Windows native, no-compile stack | WSL networking fixed (DEVIATION-001) |

---

## 9. Working conventions

- Conventional commits, one logical change per commit, gates green before commit.
- Any deviation from a numeric gate: open `docs/decisions/DEVIATION-<n>.md` with
  data and stop the phase. Never lower the gate.
- Vendored eval corpus and lockfiles are immutable inputs. Never fix a failing
  benchmark by changing the corpus.
- **Measure before claiming.** No optimization ships without a before/after on a
  suite that actually exercises it.
- Prefer deleting code to adding flags. The harness's value is what it leaves out.

## 10. Environment

```
OPENROUTER_API_KEY                    # provider access; required for eval
NODREL_TOKEN                          # gateway device token (P5+)
NODREL_GATEWAY_URL                    # default https://api.<domain>
OLLAMA_HOST                           # optional, default http://localhost:11434
NODREL_TELEMETRY=off|local|aggregate  # default local
```

## 11. References

- `earendil-works/pi` (MIT) — harness foundation
- `can1357/oh-my-pi` (MIT) — LSP operations to port
- TokenPilot, arXiv 2606.17016 — cache-efficient context management
- Codebase-Memory, arXiv 2603.27277 — graph retrieval token economics
- JetBrains, "Efficient Context Management" (Dec 2025) — masking vs summarization
- Local decision records: `docs/decisions/ADR-001..003`, `DEVIATION-001..002`
