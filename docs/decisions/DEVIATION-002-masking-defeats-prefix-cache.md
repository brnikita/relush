# DEVIATION-002: Masking and the prefix cache

- Status: **Revised 2026-08-31.** The original conclusion over-claimed.
- Affects: SPEC §4.4 (compaction), §6 (cache-hit KPI), P2 gate

## Correction first

The original version of this document reported that masking cost **14.9% more**
than not masking, from a single-seed comparison on two tasks.

**That number was inside the measurement noise and should not have been stated
as a finding.** Running the *identical* configuration twice, changing nothing:

| run | tokens/task | cost/task | cache hit |
|---|---|---|---|
| 1 | 30,478 | $0.00069 | 94.5% |
| 2 | 32,265 | $0.00087 | 86.8% |

That is a **26% spread in cost and 7.7pp in cache hit from run-to-run variance
alone** — larger than the effect being claimed. Provider cache entries expire on
a timescale of minutes, so two runs minutes apart see genuinely different cache
states for reasons unrelated to any code change.

SPEC §9 requires measuring before claiming. The original entry violated that
rule, and the eval harness made it easy to: it reported a mean with no spread
for cost and tokens. That is now fixed — `summarize` reports `*_sd` for cost,
tokens and cache hit, and `eval:compare` labels any difference smaller than the
pooled spread as **within noise** rather than as an effect.

## What is still true

The *mechanism* does not depend on the discredited measurement, and it is not
in doubt:

- Providers cache on an exact prefix match. This is documented behaviour, not
  an inference.
- The cached rate is **exactly 0.2× the fresh rate on every model in the
  OpenRouter catalogue** — verified directly against the live API across ten
  models, not read from a blog.
- Therefore rewriting a message costs `0.8 × S` extra, where `S` is the token
  count of everything after it.

The break-even for compacting an output of `T` tokens, with `R` subsequent
requests before the next invalidation, follows arithmetically:

```
(T − 25) × 0.2 × R  ≥  S × 0.8      ⟹      T ≥ 4S/R + 25
```

v1.0's sliding window re-masked every turn, pinning `R = 1` and making the true
threshold `T ≥ 4S`. It shipped a threshold of **50 tokens**. With a
10,000-token suffix the correct threshold is 40,025. That is a design error of
three orders of magnitude, and it stands independently of how large the
resulting cost difference happened to be on any given run.

Two further facts survive, both measured across runs and both larger than the
noise:

- Masking did **not** lengthen trajectories (15.5 turns either way), against the
  13–15% lengthening reported for LLM summarization.
- Masking cost **no** solve rate (100% both ways).

## The uncomfortable second finding

Working the arithmetic forward with realistic numbers:

| suffix | minimum output worth compacting (R = 20) |
|---|---|
| 5,000 | 1,025 |
| 20,000 | 4,025 |
| 100,000 | 20,025 |

Measured tool outputs on `longhorizon` average **~160 tokens** (28 outputs,
4,465 tokens total). They are two orders of magnitude below the threshold at
every realistic suffix size.

**Compaction as a cost optimization does not pay off on this workload, and
batching does not rescue it.** Batching raises `R` and lowers the bar by that
factor, but not by the factor of ~25 that would be needed.

This is not a defect in the implementation. It is what the arithmetic says, and
the honest response is to stop treating compaction as a cost lever.

## Resolution

§4.4 is rewritten around two modes:

- **Opportunistic** (above 60% of the window): compact only what clears
  break-even. On this workload that is usually nothing, and nothing is the
  correct answer.
- **Mandatory** (above 85% of the window): compact largest-first until the
  transcript fits, break-even notwithstanding. Near the window limit the
  alternative is not "spend slightly more" — it is a request that does not fit,
  so feasibility outranks cost.

Compaction is therefore reclassified from a **cost optimization** to a
**feasibility mechanism**. It earns its place by making long sessions possible,
not by making them cheaper.

## Consequences for the P2 gate

The P2 gate as written ("cost/task ≤ 50% of baseline on `longhorizon`") **cannot
be met by the history manager**, because on this workload the history manager
correctly declines to act. The gate is not lowered. It is reassigned: cost per
solved task is a P3 gate, to be met by the context engine — replacing whole-file
reads with budgeted graph retrieval attacks the tokens *before* they enter the
transcript, where there is no cache to lose.

P2's gate becomes what the history manager can honestly be held to:

1. Append-only below the pressure threshold, verified by test.
2. A frozen region that replays byte-identically, verified by test.
3. Failure signals preserved verbatim under both modes, verified by test.
4. Compaction under a forced-pressure scenario keeps a session inside the window
   with no solve-rate loss.
5. **No cost regression outside the measured noise floor.**

## Methodology now required

Any future performance claim must clear this bar, or it does not get made:

- ≥ 3 seeds, and the spread reported next to the mean.
- A difference smaller than the pooled spread is reported as **within noise**.
- The suite must actually exercise the feature. The `internal` suite averages
  5.1 turns and never engages the history manager at all.
