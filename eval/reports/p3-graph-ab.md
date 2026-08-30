# P3 A/B: baseline vs code graph

- Date: 2026-08-31
- Suite: `navigation`, 8 tasks × 3 seeds per configuration (48 runs)
- Model: `z-ai/glm-5.3-flash`
- Method: both configurations run back to back in one process; Welch's t-test on
  per-seed means; α = 0.05
- Reproduce: `pnpm eval:ab --suite navigation --seeds 3`

## Result

| metric | baseline | with graph | change | verdict |
|---|---|---|---|---|
| **cost/task** | $0.00028 ± $0.00001 | **$0.00016 ± $0.00002** | **−42.1%** | **significant** (t = −8.20, df = 3.1) |
| tokens/task | 7,080 ± 1,086 | 5,761 ± 441 | −18.6% | not significant |
| turns | 4.4 ± 0.2 | 3.9 ± 0.1 | −10.8% | not significant |
| wall time | 17,094 ms ± 1,342 | 23,309 ms ± 2,760 | +36.4% | not significant |
| solve rate | 100% | 100% | — | unchanged |

35 `graph_query` calls across the treatment run.

## Reading it

**Cost is the robust result.** t = −8.20 is far outside the critical value, and
it is consistent with the earlier 3-task run (−36%). The larger suite moved the
figure to −42.1%, in the same direction with more evidence behind it.

**Cost is significant while tokens are not**, which looks contradictory and is
not. Cost depends on the split between fresh and cached input, not on the raw
count: the graph run replaces large, uncacheable file reads with small
structural queries, so its cost variance is tight (±7%) while token counts still
swing with how much the model chose to read (±15% at baseline). The graph run is
roughly **twice as consistent** as the baseline, and that consistency is itself
part of the result.

**Wall time is directionally worse and not resolvable at n = 3.** Startup
indexing was measured separately at **99 ms** for a repo of this size — 1.6% of
the 6.2 s difference — so indexing is not the cause. The remaining explanation
is per-turn latency or provider load during the second run. It is reported
because it is real in the data, and it should be re-measured with more seeds
before anyone concludes either way.

## Gate

SPEC P3 requires **cost ≤ 50% of baseline**. Measured **57.1%**.

**The gate is not met and is not lowered.** Progression: 64% (3 tasks) → 57.1%
(8 tasks). Remaining levers are recorded in DEVIATION-003, with language
coverage first.
