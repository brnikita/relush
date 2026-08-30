# nodrel

A terminal coding agent built to spend fewer tokens on the same work.

Same workflow as Claude Code — read, edit, run, verify — with the expensive
parts engineered away: a local code graph answers structural questions instead
of reading whole files, history is append-only so the provider's prefix cache
keeps paying, and steps are routed to the cheapest model that can do them.

```
$ nodrel
nodrel 0.1.0  ·  ~/projects/api
indexed 214 files, 1,893 symbols (412ms)
/help for commands, /exit to quit

› which function validates the auth token?

verifyToken in src/auth/token.ts:34.

  [flash] 3,140 tokens · $0.00031
```

## Install

Requires Node ≥ 22 and an OpenRouter key.

```sh
pnpm install
pnpm build
export OPENROUTER_API_KEY=sk-or-...
node packages/cli/dist/bin/nodrel.js
```

## Use

```sh
nodrel                        # interactive session
nodrel --print "fix the off-by-one in list.js"
nodrel --json  "which tests cover parse()"    # machine-readable
nodrel --no-graph             # disable the code graph
nodrel --history              # enable batched compaction
```

| command | what it does |
|---|---|
| `/cost` | Session and weekly spend, by layer, with the escalation invariant |
| `/graph <symbol>` | Look up a symbol; also `references`, `impact`, `tests_for`, `search` |
| `/model` `/fast` `/strong` | Show or pin the model layer |
| `/reindex` | Rebuild the code graph |
| `/map` | Show the task map for a prompt |
| `/expand <sha>` | Retrieve compacted output |
| `/compact` `/clear` | Force compaction; start a fresh conversation |

## What it actually saves

Measured, not asserted. `navigation` suite, identical tasks, only the graph
differing, three seeds, Welch's t-test on per-seed means:

| | baseline | with graph | |
|---|---|---|---|
| tokens/task | 7,478 ± 587 | 5,860 ± 235 | **−21.6%**, significant |
| cost/task | $0.00025 | $0.00016 | **−36%**, significant |
| turns | 5.0 | 3.9 | **−22%** |
| solve rate | 100% | 100% | unchanged |

Reproduce with `pnpm eval:ab --suite navigation --seeds 3`.

Two claims this project does **not** make:

- **Compaction does not save money.** The prefix-cache break-even says an output
  must exceed roughly `4S/R` tokens to pay for the cache a rewrite costs;
  measured outputs are two orders of magnitude below that. Compaction ships as a
  feasibility mechanism for long sessions, not a cost lever.
  (`docs/decisions/DEVIATION-002`.)
- **Cheaper per token is not cheaper.** `ling-3.0-flash` costs 3.6× less per
  token than the default and failed a one-line bug fix in 200 s where the
  default succeeded in 18 s. The metric is cost per *solved task*.

## How it works

```
CLI ──► Session ──┬─ Graph      code index; graph_query answers from signatures
                  ├─ Context    budgeted retrieval, deterministic task map
                  ├─ History    append-only; batched compaction under pressure
                  ├─ Router     local / flash / escalation, failure-driven
                  └─ Telemetry  per-step tokens and cost, JSONL
```

Built on [Pi](https://github.com/earendil-works/pi) (MIT) as a dependency rather
than a fork: its lifecycle hooks reach everything nodrel needs to change, so
upstream updates are a version bump.

Four properties hold across packages:

- **Fixed overhead ≤ 2,000 tokens.** Currently 841. `pnpm check:budgets`
  enforces it and is never disabled.
- **No native dependencies.** WASM parsing and Node's built-in SQLite, so it
  builds on any platform without a C++ toolchain.
- **Everything reversible.** Compacted output is content-addressed and comes
  back byte-identical via `/expand`.
- **Nothing local leaves the machine** except the prompt fragments assembled for
  a step.

## Development

```sh
pnpm test           # unit tests, no network
pnpm test:live      # live-model tests (needs a key, costs money)
pnpm typecheck
pnpm lint
pnpm check:budgets  # SPEC §4.1 token budgets
pnpm bench:graph    # SPEC §4.2 index and query performance
pnpm eval:ab        # A/B a configuration change with a significance test
```

`SPEC.md` is the authoritative design document. `docs/decisions/` records every
choice that went against the spec, and why — including the ones that turned out
to be mistakes.
