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
