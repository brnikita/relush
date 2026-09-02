# Free-model A/B: graph vs baseline on the free pool

- Date: 2026-09-02
- Suite: `navigation`, 8 tasks × 3 seeds per side
- Model: `cohere/north-mini-code:free`, fallback chain
  `minimax-m3:free → nemotron-3-super:free → glm-5.2:free`
- Cost: $0 by construction. The account is exhausted; this is the only live
  path available.

## Result

| metric | baseline | with graph | change | verdict |
|---|---|---|---|---|
| tokens/task | 8,427 ± 1,079 | 5,220 ± 770 | **−38.1%** | significant (t = −4.19) |
| turns | 5.0 | 4.1 | −18.6% | within noise |
| wall time | 14.5 s ± 4.0 | 7.8 s ± 1.4 | −45.8% | within noise |
| solve rate | 19/21 (90.5%) | 19/24 (79.2%) | −11 pp | **see below** |

3 runs unattempted (whole chain errored, excluded). **52 fallbacks across 45
attempted runs**; four different models answered.

## What it supports

**The token effect replicates on a different model.** −38.1% here against
−18.6% (n.s.) and −21.6% on GLM-flash. This is the third independent
measurement pointing the same way, and the first on a model family other than
GLM, which is what a "the graph helps regardless of model" claim needs.

Wall time is *directionally better* here (−46%), the opposite of the GLM
result (+36%). Neither is significant. Together they say the earlier "2.2×
slower" finding is not a property of the graph.

## What it does not support

**The solve-rate drop is not attributable to the graph.** 52 fallbacks over 45
runs means most runs changed model mid-suite, and the two sides therefore ran
on *different model mixes*. The absolute count solved is identical (19 and 19);
the treatment side attempted three more runs and those three failed. Whether
they failed because of the graph or because they landed on `glm-5.2:free`
during a bad minute cannot be told from this data.

`eval:ab` now prints a CAVEAT line whenever the model mix differs between
sides, so this cannot be read as a harness effect by accident again.

## What a free model can and cannot prove

| | |
|---|---|
| Can | Mechanics: permissions, secret scanning, graph tooling, fallback chain. Token and turn effects *on the same model*, when the pool is stable. |
| Cannot | Cost (always $0). Cache behaviour (free tiers do not report `cacheRead`). Any comparison whose sides landed on different models. The core thesis, since the expensive side is paid by definition. |

The first attempt at this run, an hour earlier, had 109 fallbacks and a solve
rate collapsing on both sides to 37% and 8%. It was discarded as provider
weather. The harness changes that came out of it — `unattempted` marking, the
retry pass, the mix caveat — are what made this second run interpretable.
