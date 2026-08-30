# DEVIATION-003: Gates not met, and why

- Status: Open
- Date: 2026-08-31
- Affects: SPEC §6 KPIs, P3–P5 gates

SPEC §9 requires that a gate which cannot be met produces a deviation with the
data rather than a lowered bar. This is that record, kept in one place so the
project's honest position is legible without reading every phase.

## Met

| Gate | Budget | Measured |
|---|---|---|
| Fixed prompt overhead (§4.1) | ≤ 2,000 tokens | **841** |
| Core tool count (§4.1) | 5 | 5 |
| Full index, 1M LOC (§4.2) | ≤ 60 s | **32.3 s** |
| Incremental index (§4.2) | ≤ 5 s | **2.82 s** |
| Incremental speedup (§4.2) | ≥ 4× | **11.4×** |
| Query p95 (§4.2) | ≤ 100 ms | **1.8 ms** |
| Provider cache hit (§6) | ≥ 90% | 85.8–88.3% — **see below** |
| Solve rate (§6) | ≥ 95% of baseline | **100%**, unchanged |

## Not met

### Cost per solved task ≤ 50% of baseline (P3)

Measured **64%** of baseline (−36%) with the graph enabled — a statistically
significant improvement, but short of the gate.

The gate is not lowered. Remaining levers, in expected order of value:

1. **Language coverage.** 13 of the 15 §4.2 requires. A task in an unindexed
   language falls back to whole-file reads entirely.
2. **The task map as pinned context.** Built and tested, not yet injected, so
   orientation is still paid per turn.
3. **SCIP.** Cross-file calls resolve by unambiguous name today; ambiguous names
   are deliberately left unresolved, which costs recall on `references` and
   `impact` in large codebases.

### Cache hit ≥ 90% (§6)

Measured 85.8% (baseline) and 88.3% (graph). The target was raised from the
spec's 75% *because* the baseline already beat it, and the raised figure is not
yet met. This is a self-inflicted gate and it stays where it is.

### Local-layer token share ≥ 30% (§6)

**Not claimable on this hardware.** The reference machine has 12 GB VRAM against
the 24 GB profile the KPI is specified for (§4.6). The local layer is built and
routed to, but the measurement requires a 24 GB machine. Every report that
touches it is stamped `hardware: simulated`.

### Escalation share ≤ 15% (§4.5)

Enforced and unit-tested, but **not yet exercised on a real escalating run** —
no eval task in the current suites triggers two consecutive verification
failures. The invariant holds trivially at 0% because nothing escalates. A task
designed to fail twice is needed before this counts as measured.

### Performance gates on the pinned corpus (§4.2)

All four pass on a **synthetic** 1M-LOC corpus. `eval/corpus.lock` does not yet
pin the three OSS repos §4.2 names. Synthetic code has uniform naming and call
density, so cross-file resolution meets fewer ambiguous names than real code and
traversal fan-out is more regular. `bench:graph` prints this on every run and the
gates are not claimed until the real corpus lands.

### Suites short of spec

| Suite | Required | Present |
|---|---|---|
| SWE-bench Verified-50 | 50 | **0** — needs per-task Docker images |
| Terminal-Bench subset | 20 | **0** |
| Internal | 30 | 8 |
| Long-horizon | — | 2 |
| Navigation | — | 8 |

The internal suite is also too easy: 100% solve rate at baseline leaves no
headroom, so the solve-rate gates cannot discriminate. Tokens per solved task is
the metric doing the work.

## Not started

P5 in full: gateway client, BYOK keychain, offline mode, `curl | sh` installer,
secret scanner, crash recovery, config import from `.claude/`/`.cursor/`.
