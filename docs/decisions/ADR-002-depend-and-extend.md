# ADR-002: Depend on Pi rather than fork it

- Status: Accepted
- Date: 2026-08-30
- Refines: SPEC.md §1.1 ("Fork of Pi")

## Context

SPEC §1.1 calls for forking Pi. But nodrel's actual value — the context engine,
history manager and router — is behavioural, and Pi already exposes lifecycle
hooks. Owning the source is only justified if those hooks are insufficient.

Two facts also argued against a literal fork: the upstream repo moved to
`earendil-works/pi` and now has 10 packages rather than 4, and it uses npm
workspaces where SPEC §0.5 mandates pnpm. A hard fork pays that migration and
then re-pays it on every upstream sync — and upstream auto-closes PRs from new
contributors, so there is no upstreaming path to amortize it.

## Decision

Depend on `@earendil-works/*` as versioned packages. nodrel's packages attach
through `AgentOptions` hooks, composed by `@nodrel/core`.

The mapping was verified against `pi-agent-core@0.84.4`'s type definitions, and
each hook carries the mechanism a nodrel package needs:

| nodrel need | Pi hook | Why it suffices |
|---|---|---|
| Masking, compression, prefix pinning | `transformContext` | Rewrites the message array before each provider request |
| Tool-output compression | `afterToolCall` | `content` "replaces the tool result content array in full" |
| Tool interception | `beforeToolCall` | Returns `{ block, reason }` |
| **Per-step layer selection** | `prepareNextTurnWithContext` | `AgentLoopTurnUpdate` carries `model?: Model<any>` |
| Telemetry | `subscribe`, `onPayload`, `onResponse` | Lifecycle events with usage |

The router was the decisive one: per-step model swapping is the mechanism the
whole three-layer design rests on, and it is available without owning the loop.

An integration test (`agent.integration.test.ts`) runs a turn through the real
`Agent` and asserts a history stage's output is what the provider receives —
so this ADR rests on observed behaviour, not on reading a type.

## Consequences

- Upstream updates are a version bump, not a merge across 10 packages.
- pnpm is kept, satisfying SPEC §0.5 without migrating upstream's npm setup.
- **The risk**: a future need may require loop internals no hook exposes. The
  mitigation is the hybrid path — vendor that single package, with an ADR
  recording why the hook was insufficient. Nothing about this decision makes
  that harder later.
- `@nodrel/core` owns hook composition, so ordering semantics (stages pipe,
  guards short-circuit, planners are last-wins) are defined and tested in one
  place rather than implied by registration order across packages.
