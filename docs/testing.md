# Testing

Three tiers, separated because model availability is not something CI should
depend on.

## Unit — `pnpm test`

Mocked provider, no network, deterministic. This is the bulk of the suite and
the only tier CI runs. It needs no API key.

## Live smoke — `*.live.test.ts`

Excluded from the default run (see `vitest.config.ts`). These make real
provider calls to prove tool-call round-trips actually work.

They use a **fallback chain**, not a single model, because free models sit in a
shared upstream pool and return `429` unpredictably — `z-ai/glm-5.2:free`, the
strongest free model on paper, failed on the first call during F0:

1. `cohere/north-mini-code:free`
2. `minimax/minimax-m3:free`
3. `nvidia/nemotron-3-super-120b-a12b:free`

All three were verified emitting correct tool calls. Run them locally with a
populated `.env`.

## Eval — `pnpm eval:*`

Paid `z-ai/glm-5.3-flash` ($0.075/M in, $0.25/M out). The free tier's request
cap makes a full `eval:baseline` impractical, and `openrouter/free` is unusable
here because it picks a random backend per call, which destroys reproducibility.

Never run against the free tier and never in CI.

## Lint configuration note

`complexity/useLiteralKeys` is disabled in `biome.json`. It contradicts the
TypeScript settings this project deliberately uses: with
`noUncheckedIndexedAccess` and index-signature types such as `process.env`,
bracket access is what the compiler requires, so the rule would fight `tsc` on
every access. No other recommended rule is disabled.

## Measurement discipline

Three rules, each learned by breaking it.

**Never rebuild during a measurement.** The eval harness spawns a fresh `node`
per task, so a `pnpm build` mid-run silently changes the code under test between
one task and the next. This was nearly done during the P3 A/B; it survived only
because the commits landing mid-run touched tests and re-exports rather than the
agent's runtime path, which was luck rather than method. Check
`git log --since=<run start>` against `packages/*/src/*.ts` before trusting any
comparison that spanned a commit.

**Run both sides back to back.** Provider cache state moves on a timescale of
minutes, so comparing a fresh run against a stored baseline measures the clock
as much as the change. `eval:ab` runs control and treatment in one process for
this reason.

**Report the spread, and respect it.** Identical configurations measured 26%
apart on cost at two tasks and one seed. A difference smaller than the pooled
spread is not an effect, and `eval:ab` labels it as such via Welch's t-test on
per-seed means. This project has already withdrawn one published figure for
violating this (DEVIATION-002).
