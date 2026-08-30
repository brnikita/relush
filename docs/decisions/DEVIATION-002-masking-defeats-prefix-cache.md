# DEVIATION-002: Masking reduces tokens but increases cost

- Status: Open — blocks the M1 gate
- Date: 2026-08-31
- Affects: SPEC §4.4 (masking), §4.5/§6 (cache-hit KPI), §7 M1 gate

## Measurement

`longhorizon` suite, 2 tasks, 1 seed, `z-ai/glm-5.3-flash`, identical tasks
both sides. The only difference is `--history`.

| | masking off | masking on | change |
|---|---|---|---|
| solve rate | 100% | 100% | — |
| mean turns | 15.5 | 15.5 | — |
| tokens/task | 32,148 | 29,140 | **−9.4%** |
| cache hit | 93.8% | 83.2% | **−10.6pp** |
| **cost/task** | **$0.00074** | **$0.00085** | **+14.9%** |
| blended $/M tokens | $0.023 | $0.029 | +26% |

28 outputs were masked, eliding 4,465 tokens.

## What this shows

Masking works as designed and costs more than it saves.

Two of SPEC §1.1's claims are confirmed: masking did not lengthen the
trajectory (15.5 turns either way, against the 13–15% lengthening reported for
LLM summarization) and did not cost quality (100% solve rate both sides).

But masking and prefix caching are in direct tension, and the spec does not
acknowledge it. Masking rewrites tool outputs **in the middle** of the
transcript. A provider cache matches on an exact prefix, so the first rewritten
message invalidates the cache for itself and everything after it. The result is
fewer tokens, a larger fraction of them billed at the fresh rate — on flash,
5× the cached rate — and a net cost increase.

The saving is real but small (−9.4% tokens) because tool outputs in these tasks
are modest; the cache penalty is proportionally larger (−10.6pp) because it
applies to the whole suffix, not just the masked messages.

## Why the gate is not lowered

SPEC §9 forbids weakening a gate to make it pass, and SPEC §7 M1 requires
tokens/task ≤60% of M0 **and** cache-hit ≥70%. Cache-hit still passes; the
token target does not, and the cost regression is worse than the token miss.
Reporting −9.4% as progress toward −40% would misrepresent a design that
currently makes the product more expensive.

## Options, not yet chosen

1. **Mask only at a stable boundary.** Mask a contiguous prefix of old turns
   and never re-mask, so the rewritten region is itself stable and re-enters
   the cache after one request. Costs one cache miss per masking event instead
   of one per request.
2. **Mask only outputs above a much higher threshold.** The cache penalty is
   roughly fixed per event; the saving scales with output size. There is a
   break-even size, and 50 tokens is far below it.
3. **Defer masking until context pressure.** Take the cache hit only when
   approaching the window limit, where the alternative is truncation.
4. **Re-evaluate against a provider without prefix caching**, where masking is
   unambiguously positive.

Option 1 looks most promising and preserves the spec's intent. It needs its own
measurement before adoption.

## What must not happen

Masking must not ship enabled by default on this evidence. It is currently a
cost regression on the only suite long enough to exercise it.
