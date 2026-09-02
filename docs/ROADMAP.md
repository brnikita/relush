# Roadmap: from prototype to product

- Date: 2026-09-02; progress marked 2026-09-02 (free-model pass)
- Status of the codebase this plans from: 43 commits, 372 tests, P0–P3 done,
  P4 partial, P5 not started. Measured position in `eval/reports/verdict.md`.

Ordered by expected effect on competitive advantage, not by the phase numbers
in `SPEC.md`. Each item states what is done, what is missing, what "done" looks
like, and what it depends on. Estimates are for one engineer.

---

## The one question that decides whether there is a product

Everything measured so far is on synthetic tasks of 12–15 files that both the
cheap model and an expensive one solve at 100%. That suite cannot show an
advantage, because quality has nowhere to fall.

The claim the product rests on is: **a cheap model with a code graph holds its
solve rate where an expensive model is otherwise needed, at a fraction of the
cost.** There is no data on this yet. The single head-to-head run (17× cheaper,
2.2× slower, both correct) is n = 1 and proves only the order of magnitude.

Item 1 exists to answer that question. If the answer is no, items 2–7 are
optimizing a product that does not work, and the plan should stop there.

---

## 1. Prove the thesis on real tasks

**Why first.** Without this, every number in the project is internal.

| | |
|---|---|
| Done | Eval harness with verification-by-execution, `eval:ab` with Welch's t-test, 21 tasks across 4 suites, M0 baseline frozen, `--control-model`/`--treatment-model` flags. **[2026-09-02]** `--fallback` model chain with a retry pass; runs where every model errors are marked *unattempted* and excluded from solve rate rather than counted as failures |
| Missing | SWE-bench Verified-50 (needs per-task Docker images), Terminal-Bench subset, a real pinned corpus for `bench:graph`, credits for ≥ 24 expensive-model runs. **Blocked on credits**: the account is at $90.00/$90 |
| Done means | `eval:ab --suite swebench --control-model anthropic/claude-sonnet-5 --treatment graph --seeds 3` reports solve rate, cost and wall time with significance verdicts, and the result is committed to `eval/reports/` whatever it says |
| Depends on | OpenRouter credits (account is exhausted at $90.00/$90); Docker (installed); ~40 GB disk for images |
| Estimate | 2 weeks |

Tasks:

1. Vendor SWE-bench Verified-50 as `eval/tasks/swebench/` with a Docker-backed
   `Task.materialize()` and `Task.check()` running the upstream test command.
2. Pin three OSS repos (~100k / 1M / 10M LOC) by commit in `eval/corpus.lock`
   and point `bench:graph` at them. Retire the synthetic corpus.
3. Add ≥ 10 `longhorizon` tasks that reach 30+ turns, so the history manager is
   exercised on something realistic.
4. Run the head-to-head at ≥ 24 runs per side and commit the report.

Free-model note (2026-09-02): the first free A/B was unusable — 109
fallbacks over 48 runs, 15 logged, solve rate collapsing on both sides — because
the shared pool was saturated. That is what motivated the `unattempted` marking
and the retry pass. Free models can validate the *mechanics* here; they cannot
answer the thesis, because the expensive side is paid by definition.

**Exit criterion for the whole roadmap:** solve rate within 5 pp of the
expensive model at ≤ 25% of its cost on SWE-bench-50. If that fails, revisit
the model choice (item 7) before anything else.

---

## 2. Close the latency gap

**Why.** nodrel measured 2.2× slower per task than Sonnet. It is the only metric
where it loses, and for an interactive tool it is the one users feel first. A
tool that is 17× cheaper and 2× slower is a batch tool, not a Claude Code
replacement.

| | |
|---|---|
| Done | Per-turn cost line; wall time recorded per task. **[2026-09-02] ✅ `TurnTimer`**: splits each turn into TTFT / provider round trip / tool time with the remainder attributed to the harness (7 tests) |
| Missing | Wiring the timer into the runner output; streaming; parallel tool execution; the measurement itself |
| Done means | Median wall time per `navigation` task within 1.3× of the expensive model, measured at ≥ 3 seeds |
| Depends on | Item 1's harness for the measurement |
| Estimate | 1–2 weeks |

Tasks:

1. ~~**Instrument first.**~~ ✅ Done — `TurnTimer` in `@nodrel/telemetry`. Still
   to wire into `run-task` output and `eval:ab`.
2. Stream assistant output to the terminal. Pi's `AgentEvent` stream already
   carries deltas; the CLI currently waits for the whole turn.
3. Enable `toolExecution: "parallel"` where tool calls are independent
   (`read` + `graph_query` in the same turn).
4. If the gap is provider TTFT: evaluate a second flash provider for the same
   model by measured latency, and let the router prefer it interactively.

---

## 3. Reach the cost gate

**Why.** The P3 gate is cost ≤ 50% of baseline; measured 57%. The levers are
known and ordered by expected value.

| | |
|---|---|
| Done | Graph, `graph_query`, cross-file call resolution by unambiguous name, task map (built and tested), 13 languages, retrieval-miss tracking |
| Missing | Task map not injected; SCIP; Kotlin and Swift; retrieval-miss events not wired to telemetry |
| Done means | `eval:ab --suite navigation --seeds 3` reports cost ≤ 50% of baseline, significant |
| Estimate | 3 weeks |

Tasks:

1. **Inject the task map as pinned context** before the first turn. It is
   byte-stable and tested; orientation is still paid per turn because it is not
   wired in. Verify with the prefix-stability test that it does not drift.
2. **SCIP for TypeScript, Python, Go.** Ambiguous names are deliberately left
   unresolved today; on a real codebase that is most of them. Keep the
   tree-sitter fallback and measure recall on `references` before/after.
3. Wire `RetrievalTracker` into the session so `retrieval_miss` events land in
   telemetry, then use the miss rate to tune `graph_query` response format.
4. Kotlin and Swift grammars, to reach the 15 the spec requires.

---

## 4. The local layer — the advantage competitors cannot price-match

**Why.** Every cloud-only agent pays the same provider prices. Running
classification, summarization, commit messages and single-symbol edits on the
user's own hardware at zero marginal cost is the one structural edge that
cannot be copied by a price cut.

| | |
|---|---|
| Done | Router routes `trivial` and `local` task classes to the local layer when told one exists; local tokens exempt from budget accounting |
| Missing | Everything else: hardware detection, Ollama adapter, `cost: 0` provider registration, graceful degradation, `local_degraded` event |
| Done means | On a 24 GB machine, ≥ 30% of tokens run locally on the `internal` suite with solve rate unchanged (the SPEC §6 KPI) |
| Depends on | **A 24 GB GPU.** The reference machine has 12 GB and cannot host the profile; this KPI is not measurable here (DEVIATION-003) |
| Estimate | 2 weeks, plus hardware |

Tasks:

1. Hardware detection (VRAM / unified memory) → profile, per SPEC §4.6.
2. Ollama adapter as an OpenAI-compatible provider with `cost: 0`.
3. Degradation path: local unreachable ⇒ flash, without interrupting the
   session, emitting `local_degraded`.
4. Measure the local-share KPI on a 24 GB machine; stamp anything measured
   elsewhere `hardware: simulated`.

---

## 5. UX parity with Claude Code

**Why.** The spec promises workflow equivalence. Today the CLI is a readline
loop, and `bash` runs anything without asking — which is a blocker for any
user who is not the author.

| | |
|---|---|
| Done | Interactive, `--print`, `--json`; full slash-command set; per-turn cost line. **[2026-09-02] ✅ `bash` permission modes** — `allowlist` / `confirm` / `yolo` with a deny list that wins in every mode, an append-only audit log at `.agent/audit.jsonl`, `--permissions` flag; defaults to `confirm` on a TTY and `allowlist` when piped (27 tests, verified live) |
| Missing | Streaming TUI, tool-call display, layer badge; session resume; `--rpc`; SDK entry point; config import from `.claude/` / `.cursor/` / `.codex/` |
| Done means | A user who has used Claude Code can sit down at `nodrel` and not notice a missing capability in a day's work |
| Estimate | 3 weeks |

Tasks, in order of risk:

1. ~~**`bash` permission modes**~~ ✅ Done. Verified live: a free model told to
   `rm -rf a.js` was blocked, the file survived, both decisions are in the audit
   log.
2. Streaming TUI on `@earendil-works/pi-tui`: assistant deltas, tool calls as
   they start and finish, the `[layer]` badge per step.
3. Session persistence and `--resume`: Pi's JSONL session tree, plus the
   `layer`/`cost` fields SPEC §4.1 adds to each record.
4. Read-only import of rules and skills from `.claude/`, `.cursor/`, `.codex/`,
   `.cline/` on first run.
5. `--rpc` (JSON-RPC over stdio) and an importable SDK, for editor integration.

---

## 6. Distribution and security

**Why.** None of this creates advantage; all of it is required to ship.

| | |
|---|---|
| Done | No native dependencies (WASM parsing, `node:sqlite`) — builds anywhere without a C++ toolchain. **[2026-09-02] ✅ Secret scanner** — 12 gitleaks-shaped rules, runs as the last history stage on every role including tool results, typed placeholders, redactions in the audit log (18 tests, verified live) |
| Missing | Installer, binaries, BYOK keychain, offline mode, crash recovery, gateway client |
| Done means | `curl -fsSL <domain> \| sh` produces a working binary on macOS-arm64 and linux-x64 CI runners; a session survives `kill -9` mid-tool-call; no API key ever appears in an outbound prompt |
| Estimate | 3 weeks |

Tasks:

1. ~~**Secret scanner**~~ ✅ Done. Verified live: the model was told to `cat
   .env` and report the key; what reached it was
   `OPENROUTER_API_KEY=[REDACTED:openrouter-key]`. GitHub push protection
   flagged a test fixture as a real token on first push — fixtures are now
   assembled from parts.
2. Crash-safe session state: resume after `kill -9` during a tool call.
3. BYOK via OS keychain for OpenRouter / Anthropic / OpenAI keys.
4. Installer and per-platform binaries; `scripts/install-e2e.sh` on CI.
5. Offline mode: cached limits, local-only or BYOK.
6. Gateway client (device token, usage sync, price refresh) — last, because it
   depends on a billing backend that is a separate repo.

---

## 7. The product's own economics

**Why.** The ≤ $14/month model rests on GLM-flash at $0.075/M and a 0.2× cache
rate. Both are someone else's prices and both will change. The measurement that
`ling-3.0-flash` is 3.6× cheaper per token and solves nothing means price per
token is not the number to track.

| | |
|---|---|
| Done | Prices pinned in `packages/ai/src/models.ts`; cost-per-solved-task as the eval metric; cache ratio asserted in CI |
| Missing | Price refresh from the catalogue; model selection by cost per solved task; alerting when the cache ratio changes |
| Done means | A weekly job re-runs the `smoke` suite across the top-3 flash candidates and reports cost per solved task, and the default is chosen from that rather than from a hardcoded id |
| Estimate | 1 week |

---

## Sequencing

```
week  1–2   item 1  — prove the thesis           ← decision point
week  3–4   item 2  — latency
week  5–7   item 3  — cost gate
week  8–10  item 5  — UX parity (permissions first)
week 11–13  item 6  — distribution and security
week 14–15  item 4  — local layer (needs hardware)
week 16     item 7  — economics
```

Item 4 is placed late only because it needs hardware the project does not have;
if a 24 GB machine is available it moves to week 3.

## Progress log

| date | done | verified on |
|---|---|---|
| 2026-09-02 | Model fallback chain + retry pass in the runner; unattempted runs excluded from solve rate | free models, live |
| 2026-09-02 | `bash` permission modes with audit log (item 5.1) | free model, live |
| 2026-09-02 | Secret scanner on outbound prompts (item 6.1) | free model, live |
| 2026-09-02 | `TurnTimer` latency breakdown (item 2.1, instrument only) | unit tests |

## What this plan refuses to do

- Lower a gate to make it pass (SPEC §9). Every unmet gate is in
  `docs/decisions/DEVIATION-003.md` with its number.
- Claim an effect inside the noise floor. `eval:ab` labels those, and one such
  claim has already been withdrawn (DEVIATION-002).
- Present compaction as a cost saving. The break-even arithmetic says it is not,
  and it ships as a feasibility mechanism only.
- Ship `bash` without permission modes to anyone but the author.
