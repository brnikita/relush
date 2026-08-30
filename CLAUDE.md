# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository state

Greenfield: the repo contains only `SPEC.md` and has **no commits yet**. There is no `package.json`, no toolchain, and none of the commands below exist until M0 creates them. Do not assume any build/test command works — check that the script exists in the relevant `package.json` first.

`SPEC.md` is the authoritative source for everything: architecture, milestones, numeric gates, and defaults. Read it before any non-trivial work. It is written as instructions to the coding agent, and those instructions apply to you.

## What this project is

`nodrel` — a terminal coding agent (working name; binary name substitutable via `BRAND` at build time) built as a fork of **Pi** (`badlogic/pi-mono`, MIT). Functionally equivalent to Claude Code, but engineered to minimize token consumption: a code graph replaces whole-file reads, history is masked rather than summarized, and requests are routed across a local / cheap-cloud / strong-model ladder.

TypeScript strict mode, Node ≥ 22, pnpm workspaces. Eval harness is Python, `uv`-managed.

## Working rules (from SPEC.md §0 and §9)

- Execute milestones **in order** M0 → M5. Do not start a milestone before the previous one's verify command exits 0 and its gate table is met.
- Where the spec leaves a choice open, take the **Default** column in §8 and log an ADR in `docs/decisions/`. Do not ask for confirmation on those.
- **Never lower a numeric gate.** If a gate cannot be met, open `docs/decisions/DEVIATION-<n>.md` with the data and stop the milestone.
- The vendored eval corpus (`eval/corpus.lock`) and lockfiles are immutable inputs. Never fix a failing benchmark by changing the corpus.
- Conventional commits, one logical change per commit.
- Prefer deleting code to adding flags — the harness's value is what it leaves out.

## Commands (as specified; each lands in its own milestone)

```
pnpm test                                    # unit tests
pnpm bench:smoke                             # 5 cheap eval tasks; runs in CI on every PR
pnpm check:budgets                           # token-budget CI check — never disable this
pnpm eval:baseline                           # M0 verify; freezes eval/reports/m0-baseline.json
pnpm eval:compare --against m0 --suite swe50 # M1/M2 verify
pnpm bench:graph                             # graph perf gates on the pinned corpus
pnpm eval:full --against m0                  # M3/M5 verify
pnpm test:gateway && scripts/install-e2e.sh  # M4 verify
```

CI target: `pnpm test && pnpm bench:smoke` green on every commit to `main`.

## Architecture

Monorepo (`packages/`), each package a seam the spec depends on:

- `core` — fork of `pi-agent-core`; agent loop plus 20+ lifecycle hooks (`beforeToolCall`, `afterToolCall`, message transforms). The hooks are how context/history/router plug in without touching the loop.
- `ai` — fork of `pi-ai`; adds the gateway provider and cost tables. Local models register here as an OpenAI-compatible custom provider with `cost: 0`.
- `cli` — fork of `pi-coding-agent`; TUI, `--print/--json`, `--rpc`, SDK, slash commands.
- `graph` — tree-sitter (15 langs) + SCIP indexer into a Kùzu store behind a `GraphStore` interface. SQLite is a fallback implementation; **both must pass the same conformance suite**. Data stays in `<repo>/.agent/graph/` and never leaves the machine.
- `context` — budgeted retrieval over the graph (`graph_query`) plus the deterministic task map.
- `history` — observation masking, hybrid summarization, reversible compression, prefix pinning.
- `router` — layer selection (local / flash / escalation / byok), fallbacks, budget accounting.
- `local` — hardware detection and Ollama/llama.cpp/MLX adapters.
- `telemetry` — JSONL event sink, `/cost` aggregation.

Per-step flow: router classifies → context engine builds a task map within budget (no LLM call) → history manager assembles messages (old outputs masked, prefix pinned) → tool layer exposes 5 core tools + top-k skills → request to the selected layer → failure signals feed back into router state.

## Invariants that cut across packages

These are the design; violating one breaks the product's reason to exist.

- **Fixed overhead ≤ 2,000 tokens** (system prompt ≤ 800 + core tool schemas + pinned instructions), counted with the target model's tokenizer. Only `read`, `write`, `edit`, `bash`, `graph_query` are default tools — everything else is a lazily loaded skill.
- **Prefix stability.** System prompt, core tool schemas, and task map are byte-stable for the whole session; all dynamic content appends after them. This is what earns the ≥ 75% provider cache-hit rate, and a CI test asserts it across 50 synthetic turns.
- **Masking is the default, summarization is the exception.** Tool outputs older than N=6 turns become `[output masked: <tokens> tokens, sha=<xxh3>]`; summarization only fires above 60% of the window with turns older than M=20. LLM summaries hide failure signals and lengthen trajectories — do not make them the default path.
- **Everything is reversible.** Masking and compression keep originals in `.agent/cache/` keyed by hash, retrievable via `expand(id)`. No token-level pruning — it breaks code syntax.
- **Graph responses are signatures, never bodies.** Name, params, types, first docstring line; a body is a separate explicit fetch. Every response is token-budgeted (default 4,000) with the over-budget tail returned as expandable opaque ids.
- **Escalation share ≤ 15% of tokens** across the eval suite — a CI-tested hard invariant, not a target.
- **Nothing local goes to the cloud.** Graph enrichment and summarization use the local model or degrade (identifier match / flash); enrichment never calls cloud. Local tokens do not count against budget caps.
- Provider API keys live server-side only; BYOK keys in the local keychain. A gitleaks-rule secret scanner redacts every outbound prompt.

## Reference decisions — do not re-litigate

SPEC.md §1.1 encodes research behind masking-over-summarization, the graph's ~10x token reduction (and the ~9pp quality cost that budgeted expand-on-demand must claw back), tool-description filtering, and 70/20/10 routing. Treat these as settled inputs.

## Environment

```
NODREL_TOKEN                          # gateway device token (M4+)
NODREL_GATEWAY_URL                    # default https://api.<domain>
OPENROUTER_API_KEY                    # dev/testing + BYOK path
OLLAMA_HOST                           # optional, default http://localhost:11434
NODREL_TELEMETRY=off|local|aggregate  # default local
```

Never commit secrets, provider keys, or user code samples. Keys come only from these env vars.

## Platform note

The primary working directory is Windows (`C:\Users\Nikita\Projects\relush`), but the product targets macOS/Linux with **Windows support via WSL only**. Build scripts, the installer (`curl | sh`), and `scripts/install-e2e.sh` are POSIX; run them under WSL or a POSIX shell, not PowerShell.
