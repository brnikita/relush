# ADR-003: BLAKE2b for content hashing, not XXH3

- Status: Accepted
- Date: 2026-08-30
- Refines: SPEC.md §4.2 ("XXH3 content hashes") and §4.4

## Context

Two subsystems hash content: the reversible cache backing masking and
compression (§4.4), and incremental indexing (§4.2). The spec names XXH3,
presumably chosen for throughput against the §4.2 gate of a full 1M-LOC index
in ≤60 s.

XXH3 is not in Node's standard library. Adding it means a dependency —
`@node-rs/xxhash` (native, needs a compiler) or `xxhash-wasm` / `hash-wasm`
(WASM).

## Decision

Use **BLAKE2b (`blake2b512`) from `node:crypto`**, truncated to 32 hex
characters, and take no dependency.

Measured on the reference machine:

| algorithm | 50 MB (≈1M LOC) |
|---|---|
| `blake2b512` | **84 ms** |
| `sha256` | 152 ms |

Hashing consumes 0.14% of the 60 s indexing budget. XXH3 would be perhaps 5–10×
faster, saving under 80 ms on a full index of the largest corpus repo — against
a gate with three orders of magnitude of headroom.

## Consequences

- **No dependency, and the no-native-dependency property from ADR-001 holds.**
  That property is what lets the project build on Windows, macOS and Linux
  without a C++ toolchain, and it should not be spent on 80 ms.
- BLAKE2b is cryptographically strong, so collisions are not a practical
  concern. Truncating to 128 bits leaves a collision probability far below the
  rate at which unnoticed disk corruption would occur.
- **Revisit trigger**: if `pnpm bench:graph` (F28) shows hashing as a material
  share of index time on the pinned corpus, swap in `xxhash-wasm` — WASM keeps
  the portability property intact. The hash is used through `hashContent`, so
  the change is one function.
