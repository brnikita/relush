# Technical Specification: Token-Optimized Coding Agent CLI

Version 1.0 — 2026-08-30
Audience: **an autonomous coding agent (Claude Code)** executing this spec end-to-end, plus human reviewers.
Working name: `nodrel` (CLI binary name; substitute via `BRAND` env in build if renamed).

---

## 0. How to use this document (instructions to the coding agent)

1. Execute milestones **in order** (M0 → M5). Do not start a milestone until the previous one's acceptance gate passes.
2. Every milestone ends with a runnable verification command. A milestone is DONE only when its command exits 0 and the metrics in its gate table are met.
3. When this spec leaves a choice open, take the **Default** column. Log the decision in `docs/decisions/` as an ADR; do not ask for confirmation.
4. Never commit secrets, provider keys, or user code samples. Keys come only from env vars listed in §10.
5. All work in TypeScript strict mode unless a section says otherwise. Node ≥ 22. Package manager: `pnpm`.
6. Write tests before or with implementation. CI target: `pnpm test && pnpm bench:smoke` green on every commit to `main`.
7. Keep the core system prompt and tool schemas under the token budgets in §4.1. There is a CI check for this (`pnpm check:budgets`); it must never be disabled.

---

## 1. Product summary

A terminal coding agent equivalent in workflow to Claude Code (interactive TUI, agentic loop, file edits, bash, tests), but designed from the ground up to **minimize token consumption and latency**:

- Minimal harness overhead (system prompt + tools ≤ 2,000 tokens per request).
- A local **code graph** replaces whole-file reads with budgeted structural retrieval.
- **History management**: observation masking + hybrid summarization keeps long sessions cheap.
- **Model routing** across three layers: local model → cheap cloud default → strong-model escalation.
- Stable prompt prefix to maximize provider KV-cache hits.

Economic target (from the companion financial model): variable cost ≤ $14/month for a weighted user consuming 133M tokens/month, which requires blended cost ≤ ~$0.10 per 1M tokens and escalation share ≤ 15% of tokens.

### 1.1 Foundation

Fork of **Pi** (`badlogic/pi-mono`, MIT): packages `pi-ai` (LLM abstraction), `pi-agent-core` (agent loop, hooks), `pi-coding-agent` (CLI/TUI), `pi-tui`. Rationale: sub-1,000-token system prompt, 4 base tools, 20+ lifecycle hooks (`beforeToolCall`, `afterToolCall`, message transforms), runtime TypeScript extensions, RPC/SDK modes. Track upstream monthly; keep extension/skill format compatible.

Reference research the design encodes (do not re-litigate these choices):
- Observation masking matches LLM-summarization quality at zero extra compute; LLM summaries lengthen trajectories 13–15% by hiding failure signals (JetBrains, SWE-bench Verified). → masking is the default, summarization only on overflow.
- Tree-sitter code knowledge graph over MCP: ~10x fewer tokens, 2.1x fewer tool calls, at ~9pp answer-quality cost (Codebase-Memory, arXiv 2603.27277). → graph retrieval must be budgeted and expandable-on-demand to claw back the quality gap.
- Tool-description overhead: filtering 29 tools → relevant subset cut description tokens 82% and selection errors 89%. → lazy skills + semantic tool selection.
- Model routing 70/20/10 (cheap/mid/strong) ≈ 25–30% of all-frontier cost. → router is a first-class component.

---

## 2. Scope

**In scope (v1):** CLI harness (interactive TUI, `--print/--json`, RPC, SDK); graph indexer + context engine; history manager; router; local-model runtime; cloud gateway client; telemetry; eval harness; installer script.
**Out of scope (v1):** web UI, team features, model hosting, Windows-native (WSL only), IDE plugins beyond RPC, the billing backend itself (client-side hooks only, server is a separate repo).

---

## 3. Architecture

```
┌────────────────────────────── user machine ──────────────────────────────┐
│  CLI / TUI / RPC / SDK  (pi fork)                                        │
│        │                                                                 │
│  Agent Loop ── hooks ──┬─ Context Engine ── Graph Store (Kùzu, .agent/)  │
│        │               ├─ History Manager (mask / summarize / compress)  │
│        │               ├─ Tool Layer (4 core tools + lazy skills + LSP)  │
│        │               └─ Telemetry (JSONL, per-step tokens & cost)      │
│        ▼                                                                 │
│  Router ──► Local Runtime (Ollama/llama.cpp/MLX)                         │
│        └──► Gateway client ──► cloud: GLM-5.3-Flash (default),           │
│                                GLM-5.3 (escalation), fallbacks, BYOK     │
└──────────────────────────────────────────────────────────────────────────┘
```

Monorepo layout (pnpm workspaces):

```
packages/
  core/          # fork of pi-agent-core + our loop extensions
  ai/            # fork of pi-ai; add gateway provider, cost tables
  cli/           # fork of pi-coding-agent; TUI, /commands
  graph/         # indexer (tree-sitter + SCIP) + Kùzu store + query API
  context/       # context engine: budgeted retrieval, task map
  history/       # masking, summarization, compression, prefix pinning
  router/        # layer selection, fallbacks, budget accounting
  local/         # local model runtime adapters + hardware detection
  telemetry/     # event schema, JSONL sink, /cost aggregation
eval/            # python eval harness (SWE-bench subset, Terminal-Bench subset)
scripts/         # install.sh, budget checks, release
docs/decisions/  # ADRs
```

### 3.1 Per-step data flow

1. User prompt → **Router** classifies the step (rules + session signals; §8).
2. **Context Engine** builds a *task map* (repo-map + top-k graph nodes) within budget; no LLM call needed.
3. **History Manager** assembles messages: old tool outputs masked, prefix pinned, overflow summarized.
4. **Tool Layer** exposes 5 core tools + top-k relevant skills (one-line stubs for the rest).
5. Request goes to the selected layer. Response/tool-calls/test-results are logged with tokens, cost, latency.
6. Failure signals (failed tests, repeated edits to the same symbol, >N files touched) update router state; two consecutive failures ⇒ escalate next step.

---

## 4. Component requirements

### 4.1 Harness core (`packages/core`, `cli`)

- Core system prompt ≤ **800 tokens**. Default tools: `read`, `write`, `edit`, `bash`, `graph_query`. Everything else is a skill loaded lazily.
- Total fixed overhead (system prompt + core tool schemas + pinned instructions) ≤ **2,000 tokens**; enforced by `scripts/check-budgets.ts` counting with the target model's tokenizer.
- Modes: interactive TUI; `--print` / `--json`; `--rpc` (JSON-RPC over stdio for IDEs); importable SDK.
- Sessions: JSONL tree (branch/fork/compact preserved from Pi). Each record adds: `layer` (local|flash|escalation|byok), `model`, `provider`, `tokens_in`, `tokens_cached`, `tokens_out`, `cost_usd`, `latency_ms`.
- On first run, import rules/skills/MCP config from `.claude/`, `.cursor/`, `.codex/`, `.cline/` if present (read-only import, never modify those dirs).
- Slash commands: `/cost` (session + week totals by layer), `/model` (pin layer), `/fast`, `/strong`, `/compact`, `/expand <hash>`, `/graph <query>`, `/reindex`.
- Output style: terse by default. Post-instruction cap: explanations ≤ 3 sentences unless the user asks; target ≥ 40% output-token reduction vs. un-instructed baseline (measured in eval).

### 4.2 Graph indexer & store (`packages/graph`)

- Parsers: **tree-sitter** for broad coverage (≥ 15 languages at v1: ts/js/tsx, python, go, java, c, cpp, c#, rust, ruby, php, kotlin, swift, bash, json/yaml); **SCIP** indexers for precise references where available (scip-typescript, scip-python, scip-go at v1; others post-v1). SCIP failure ⇒ warn and fall back to tree-sitter.
- Node types: `file, module, class, function, method, type, test, commit`. Edge types: `imports, calls, references, inherits, implements, tests, modified_in, co_changed_with`.
- Store: **Kùzu** embedded (Default) behind a `GraphStore` interface; SQLite implementation kept as fallback (both must pass the same conformance test suite). Data lives in `<repo>/.agent/graph/`; never leaves the machine.
- Incremental indexing: XXH3 content hashes + git diff; fs watcher; incremental run ≥ 4x faster than full.
- Enrichment (background, local model only, skippable): one-line NL description + embedding per function/class node, stored for `search(nl_query)`. If no local model: `search` degrades to identifier/token match — never call cloud for enrichment.
- Derived metrics: node degree (hot "god nodes"), community/module detection, `impact(diff)` = transitively affected nodes.
- Performance gates: full index of a 1M-LOC repo ≤ 60 s; incremental ≤ 5 s; any query p95 ≤ 100 ms (measured in `pnpm bench:graph` on the pinned corpus: three OSS repos ~100k/1M/10M LOC, vendored by commit hash in `eval/corpus.lock`).
- Also expose the graph as an **MCP server** (secondary distribution channel; same query API).

### 4.3 Context engine (`packages/context`)

- Tool `graph_query` operations: `overview(path)`, `symbol(name, depth)`, `references(name)`, `dependencies(name)`, `impact(diff)`, `tests_for(name)`, `search(nl_query, k)`.
- **Every response is token-budgeted** (default 4,000; per-call override). Over budget ⇒ rank by relevance + proximity to current focus; the tail is returned as opaque ids expandable via `expand(id)`.
- Response format: compressed signatures (name, params, types, first docstring line) — never full bodies; a body is a separate explicit fetch.
- **Task map**: before the first model call of a task, deterministically assemble Aider-style repo-map + top-k nodes matching the prompt; inject as pinned context. No LLM call.
- Retrieval-miss logging: if the model reads a whole file after a `graph_query` covering it, emit `retrieval_miss` with both ids (feeds tuning).

### 4.4 History manager (`packages/history`)

- **Observation masking** (Default ON): tool outputs older than `N=6` turns → `[output masked: <tokens> tokens, sha=<xxh3>]`; call + args stay; original cached locally, retrievable via `expand`.
- **Hybrid summarization**: only when context > 60% of the model window AND turns older than `M=20` exist; summarize those turns with the **local model** when available, else the flash layer; failure signals (failed tests, errors) are preserved verbatim in the summary.
- **Tool-output compression** before history insertion: AST-aware for code (drop bodies of unchanged functions in diffs/reads), structural for JSON (SmartCrusher-style key sampling), line-level verbatim scoring for logs. **No token-level pruning** (breaks code syntax). All compression reversible: originals in `.agent/cache/`, keyed by hash.
- **Prefix pinning**: system prompt, core tool schemas, and task map are byte-stable for the whole session; all dynamic content appends after them. CI test asserts prefix stability across 50 synthetic turns.
- Optional dependency: evaluate `headroom-ai` as a library for compression in M1; if adopted, wrap behind our interface (ADR required).

### 4.5 Router (`packages/router`)

- Layers: `local` (hardware-dependent), `flash` = GLM-5.3-Flash via gateway (≥ 3 providers configured), `escalation` = GLM-5.3; reserve escalation = Kimi K3; `byok` = user-supplied Anthropic/OpenAI/OpenRouter keys.
- Decision inputs: rule-based task class (regex/AST features of the prompt), `impact()` size, session failure state, explicit `/fast`/`/strong`, remaining user budget from gateway.
- Local-by-default step types: graph enrichment, summarization, commit messages, templated test generation, single-symbol edits when tests exist.
- Escalation triggers: 2 consecutive failed verification runs; `impact()` > 12 files; user `/strong`. De-escalate after 2 consecutive green steps.
- Fallbacks: 429/timeout ⇒ next provider of same model; model down ⇒ adjacent layer; every switch logged and surfaced in TUI (`layer` badge per step).
- Budget accounting: 5-hour rolling window + weekly cap fetched from gateway; **local tokens do not count** against caps.
- Hard invariant (CI-tested): escalation share of tokens over the eval suite ≤ 15%.

### 4.6 Local runtime (`packages/local`)

- Hardware detection (VRAM / unified memory) → profile: 16 GB → `gpt-oss-20b`; 24 GB → `qwen3.6-35b-a3b` (Default) or `qwen3.6:27b`; 64 GB → `qwen3-coder-next-80b-a3b`; <16 GB → cloud-only.
- Backends: Ollama (Default), llama.cpp, MLX — all via OpenAI-compatible endpoint registered as a `pi-ai` custom provider with `cost: 0`.
- Graceful degradation: local unavailable ⇒ route to flash without interrupting the session; emit `local_degraded` event.

### 4.7 Tool layer

- Semantic skill selection: local embeddings over skill descriptions (FAISS/HNSW in-process), top-k=5 per step; unselected skills appear as one-line stubs only.
- LSP operations (port from oh-my-pi): rename via `workspace/willRenameFiles`, post-edit diagnostics, go-to-definition as graph alternative for strong-LSP languages.
- Test runner tool: detects framework (vitest/jest/pytest/go test/cargo), runs targeted tests from `tests_for()`, returns structured pass/fail to the router.

### 4.8 Gateway client (`packages/ai` addition)

- Auth by device token (`NODREL_TOKEN`); provider API keys exist **only** server-side; BYOK keys stay in local keychain.
- Client duties: usage sync (window/weekly), price table refresh, provider health hints, free-plan BYOK passthrough (client talks to user's OpenRouter key directly; gateway gets metrics only).
- All gateway calls are non-blocking with a 500 ms budget; offline ⇒ cached limits + local-only or BYOK mode.

### 4.9 Telemetry & eval (`packages/telemetry`, `eval/`)

- Event schema (JSONL, local, opt-in upload of aggregates only): step id, layer, model, provider, tokens (in/cached/out), cost, latency, verification result, retrieval misses, compaction events.
- Eval harness (Python, `uv`-managed): runners for **SWE-bench Verified-50** and **Terminal-Bench 2.1 subset (20 tasks)** + 30 internal tasks; per-release report: solve rate, tokens/task, cost/task, escalation share, vs. the frozen M0 baseline. Seeds fixed; 3 runs; report mean ± sd.
- `pnpm bench:smoke`: 5 cheap tasks, runs in CI on every PR.

---

## 5. Non-functional requirements

| Area | Requirement |
|---|---|
| Privacy | Source code never leaves the machine except prompt fragments explicitly assembled for a step; graph, embeddings, caches local; full-offline mode on local layer. Secret scanner (gitleaks rules) runs on every outbound prompt; matches are redacted and logged. |
| Speed | Cold start on an indexed repo ≤ 2 s; graph query p95 ≤ 100 ms; TTFT overhead added by harness ≤ 150 ms over raw provider call. |
| Reliability | Survive any provider outage without losing the session; crash-safe session state (resume after kill -9 mid-tool-call). |
| Portability | macOS (Apple Silicon), Linux x64/arm64; Windows via WSL. |
| Licensing | Core MIT (Pi heritage); deps MIT/Apache-2; AGPL deps forbidden in distributed binaries; model licenses reviewed before default-config inclusion (Kimi K3 License: reserve only). |
| Security | `bash` behind allow-list/confirmation modes; tool-call audit log; no `eval` of remote code in extensions without user opt-in. |

---

## 6. KPIs (product-level, measured by `eval/`)

| Metric | Target | Gate |
|---|---|---|
| Tokens per solved task (SWE-bench-50, flash layer) | ≤ 35% of M0 baseline | M3 |
| Solve rate (same subset) | ≥ 90% of M0 baseline | M3 |
| Escalation share of tokens | ≤ 15% (goal 10%) | M3 |
| Fixed prompt overhead | ≤ 2,000 tokens | M1, then every CI run |
| Provider cache-hit rate | ≥ 75% of input tokens | M1 |
| Local-layer token share (24 GB profile) | ≥ 30% | M3 |
| Full index 1M LOC / incremental / query p95 | ≤ 60 s / ≤ 5 s / ≤ 100 ms | M2 |
| Output tokens vs. un-instructed baseline | −40% | M1 |

---

## 7. Milestones (execution plan for the agent)

### M0 — Fork, baseline, harness of record (est. 2 weeks)
Tasks: fork pi-mono into the monorepo layout; wire pnpm workspaces + CI (lint, typecheck, tests, `check:budgets` stub); implement telemetry event schema + `/cost`; build `eval/` with the three suites and pinned corpus; register GLM-5.3-Flash via OpenRouter as default model; run and **freeze the baseline report** (`eval/reports/m0-baseline.json`).
Gate: eval harness produces solve-rate/tokens/cost for all 3 suites, 3 seeds; report committed; `pnpm test` green.
Verify: `pnpm eval:baseline && pnpm test`

### M1 — History manager + terse output (est. 3 weeks)
Tasks: masking (N=6) with `expand`; hybrid summarization (60% window, M=20, failure-signal preservation); reversible compression per content type (decide headroom-ai vs. in-house, write ADR); prefix pinning + stability test; terse-output instruction + eval; budget checker enforcing §4.1.
Gate: on SWE-bench-50: tokens/task ≤ 60% of M0, solve rate ≥ 95% of M0; cache-hit ≥ 70%; output tokens −40%; prefix-stability test green.
Verify: `pnpm eval:compare --against m0 --suite swe50 && pnpm check:budgets`

### M2 — Graph indexer + context engine (est. 6 weeks; may start in parallel after M0)
Tasks: `GraphStore` interface + Kùzu impl + SQLite fallback + conformance tests; tree-sitter pipeline (15 langs) + SCIP (ts/py/go); incremental hashing + watcher; `graph_query` with budgets + `expand`; task map; retrieval-miss logging; `bench:graph` on pinned corpus; MCP server wrapper; ADR: Kùzu-vs-SQLite benchmark results.
Gate: performance table of §4.2 met; on SWE-bench-50 with M1+M2 combined: tokens/task ≤ 42% of M0 (i.e., −30% on top of M1), solve rate ≥ 92% of M0.
Verify: `pnpm bench:graph && pnpm eval:compare --against m0 --suite swe50`

### M3 — Router + local runtime (est. 4 weeks)
Tasks: rule classifier + session-signal state machine; layer config incl. 3 flash providers with health checks and cache-hit verification per provider; escalation/de-escalation logic; hardware detection + Ollama adapter (llama.cpp/MLX best-effort); `/fast /strong /model`; budget sync stub against a mock gateway.
Gate: full KPI table of §6 rows 1–3, 6 met on the 24 GB reference machine profile (simulate via env if hardware absent, and mark report accordingly).
Verify: `pnpm eval:full --against m0`

### M4 — Gateway client, limits, installer (est. 3 weeks)
Tasks: device-token auth flow; usage windows (5 h + weekly) enforced client-side from gateway data; BYOK (OpenRouter/Anthropic/OpenAI) via keychain; `curl -fsSL <domain> | sh` installer building per-platform binaries (bun compile or pkg); offline mode.
Gate: contract tests against the mock gateway pass; installer produces a working binary on macOS-arm64 and linux-x64 CI runners; offline mode completes a local-layer task.
Verify: `pnpm test:gateway && scripts/install-e2e.sh`

### M5 — Closed beta hardening (est. 4 weeks)
Tasks: crash-recovery tests; secret-scanner integration; docs (README, extension guide); telemetry aggregate opt-in upload; triage & fix regressions from 3 pilot repos; final eval report.
Gate: all §6 KPIs met; zero P0/P1 bugs open; final report `eval/reports/v1.json` committed.
Verify: `pnpm eval:full --against m0 && pnpm test:all`

---

## 8. Defaults for open questions (agent: pick these, write ADRs)

| Question | Default | Revisit trigger |
|---|---|---|
| Graph DB | Kùzu (SQLite fallback behind interface) | Kùzu binary size or query p95 fails gate → flip default |
| Compression lib | Evaluate headroom-ai in M1; in-house if AGPL-incompatible or <40% reduction on our corpus | ADR in M1 |
| Router classifier | Rules first; local-model classifier only if rules <85% accuracy on the labeled 500-prompt set (`eval/router-set.jsonl`, to be authored in M3) | M3 |
| Task-map format | repo-map + top-k hybrid | If eval shows pure top-k within 2% tokens, simplify |
| Flash providers | Top-3 by (price, TTFT, verified cache support) from OpenRouter at M3 time | Health-check failures |

---

## 9. Working conventions for the coding agent

- Conventional commits; one logical change per commit; PR-sized branches merged by CI.
- Any deviation from a numeric gate: do **not** silently lower the gate — open `docs/decisions/DEVIATION-<n>.md` with data and stop the milestone.
- Vendored eval corpus and lockfiles are immutable inputs; never "fix" a failing benchmark by changing the corpus.
- Prefer deleting code to adding flags. The harness's value is what it leaves out.

## 10. Environment

```
NODREL_TOKEN            # gateway device token (M4+)
NODREL_GATEWAY_URL      # default https://api.<domain>
OPENROUTER_API_KEY      # dev/testing + BYOK path
OLLAMA_HOST             # optional, default http://localhost:11434
NODREL_TELEMETRY=off|local|aggregate   # default local
```

## 11. References

pi-mono (badlogic/pi-mono, MIT) · oh-my-pi (can1357/oh-my-pi) · Codebase-Memory arXiv 2603.27277 · Lindenbauer et al. arXiv 2508.21433 · JetBrains "Efficient Context Management" (Dec 2025) · SWE-Pruner arXiv 2601.16746 · RANGER arXiv 2509.25257 · headroom (chopratejas/headroom, Apache-2.0) · Serena (oraios/serena, MIT) · Artificial Analysis model/pricing pages (GLM-5.3-Flash, GLM-5.3, Kimi K3) · companion financial model `finmodel.xlsx`.
