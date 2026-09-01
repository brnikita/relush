# Verdict: was the task solved as originally posed?

- Date: 2026-09-02
- Question asked: is the CLI working with Claude Code-level commands, and does
  it solve tasks several times more efficiently — on a weighted
  time/cost/quality basis — than expensive models, *or whatever the original
  spec's key criterion was*?

## What the original spec actually asked for

SPEC v1.0 §6 never set "beat expensive models" as a criterion. Its headline KPI
was **tokens per solved task ≤ 35% of the project's own unoptimized baseline**
(same cheap model, no graph, no history manager), with solve rate ≥ 90% of that
baseline, on SWE-bench Verified-50. The economic framing was absolute — blended
cost ≤ ~$0.10/M tokens — not relative to Claude or GPT.

So the honest answer has two parts, against two different criteria.

## Part 1 — the CLI

**Yes.** `nodrel` runs interactively, in `--print`, and in `--json`, with
`/cost /graph /model /fast /strong /reindex /map /expand /compact /clear /help
/exit`. Verified end to end on a real coding task (read → run failing test →
edit source → re-run → pass) and on structural questions answered from the
graph without reading files. 372 tests, CI green.

What it does **not** have from Claude Code: an interactive TUI beyond a readline
loop, `--rpc`, an SDK entry point, permission modes for `bash`, MCP *client*
support, and config import from `.claude/`. These are P5 items and were not
started.

## Part 2 — the spec's own criterion (tokens ≤ 35% of baseline)

**Not met, and not close.** Measured on the `navigation` suite, 8 tasks × 3
seeds, Welch's t-test:

| metric | baseline | nodrel | ratio to baseline | gate |
|---|---|---|---|---|
| tokens/task | 7,080 ± 1,086 | 5,761 ± 441 | **81%** (not significant) | ≤ 35% |
| cost/task | $0.00028 | $0.00016 | **57%** (significant, t = −8.20) | ≤ 50% |
| solve rate | 100% | 100% | 100% | ≥ 90% ✓ |

Tokens are at 81% of baseline against a 35% target. Cost — the metric the
project moved to in v2.0 because it is what the user pays — is at 57% against
50%. The escalation, cache-hit, and overhead invariants hold. The SWE-bench-50
suite the KPI is specified against was never built.

**Verdict on the spec's terms: the design direction is validated, the numeric
gate is not met, and the gate was not lowered to make it look met.**

## Part 3 — the user's criterion (vs. an expensive model)

Measured once the question was asked, with the credit that remained. One
`navigation` task (find the caller of a symbol across 13 files), both sides
solving it correctly:

| | claude-sonnet-5, plain harness | nodrel (glm-5.3-flash + graph) | ratio |
|---|---|---|---|
| cost | $0.00534 | $0.00031 (mean of 3) | **17.4× cheaper** |
| tokens | 7,940 | 5,302 | 1.5× fewer |
| wall time | 15 s | 32 s | **2.2× slower** |
| correct | 1/1 | 3/3 | equal |

On a weighted time/cost/quality basis: quality equal, cost an order of
magnitude better, time about twice worse. Whether that nets to "several times
more efficient" depends entirely on the weight given to latency. For a
background or batch agent it is decisively better; for an interactive user
watching a spinner it is a real trade-off, not a free win.

**This is n = 1 on the Sonnet side and must not be read as a measurement.** The
OpenRouter account is exhausted ($90.00 of $90 used) and pre-authorises ~3,800
Sonnet output tokens in total — roughly one task. A 48-run comparison like the
one behind Part 2 needs credits added.

Two things were found and fixed on the way to running it:

- The task runner reported `ok: true` with zero tokens when the provider
  returned an error, because Pi ends the turn with `stopReason: "error"` rather
  than throwing. Every prior measurement was audited: zero such runs, so the P3
  statistics are unaffected. The defect is now fixed and would have hidden this
  exact situation.
- Pi sends `max_completion_tokens`, but OpenRouter pre-authorises on
  `max_tokens`, which fell back to the model's 128k maximum. On a low balance
  every request to an expensive model was refused regardless of how short the
  answer would be. `resolveModel` now forces the field.

## What "several times more efficient" would take to claim

1. Credits for ≥ 24 runs on the expensive side.
2. The same `eval:ab --control-model anthropic/claude-sonnet-5
   --treatment-model z-ai/glm-5.3-flash --treatment graph --seeds 3` that was
   used for Part 2 — the flag now exists.
3. A harder suite than `navigation`. Every task here is solved by both sides,
   so quality cannot yet separate them, and the interesting question — does the
   cheap model with a graph hold up where the expensive model is needed — is
   exactly what this suite cannot ask.
