# DEVIATION-001: Development platform is Windows, not WSL2

- Status: Active
- Date: 2026-08-30
- Deviates from: the approved plan's "WSL2 Ubuntu" platform decision
- Blocks: nothing in Phases 0–3; see "Outstanding" below

## What was decided

WSL2 Ubuntu was chosen as the dev platform because the product ships POSIX-only
and because native modules (Kùzu, tree-sitter) needed a C++ toolchain the
Windows host lacks.

## What actually happened

The WSL2 Ubuntu 26.04 distro has **no outbound internet connectivity**:

| Check | Result |
|---|---|
| DNS (IPv4 A records) | works — `registry.npmjs.org` → `104.16.5.34` |
| WSL NAT gateway `10.255.255.254:53` | reachable |
| Outbound IPv4 to `1.1.1.1:443` | **fails** |
| `apt-get update`, `curl https://registry.npmjs.org` | time out |

DNS resolves and the gateway responds, but the host does not forward WSL traffic
to the internet. This is a Windows-side problem (firewall rules or Docker
Desktop's virtual network), not a misconfiguration inside the distro. Fixing it
requires editing `%USERPROFILE%\.wslconfig` and restarting WSL — which would also
terminate Docker Desktop's `docker-desktop` distro. That is a host change with
user-visible side effects, so it was not made unilaterally.

## Decision

Develop on Windows using the no-compile stack. **ADR-001 makes this nearly
free**: with Kùzu dropped and parsing on `web-tree-sitter` (WASM) plus
`node:sqlite`, the project has no native dependencies at all, so the original
reason to prefer WSL has disappeared.

Both were verified on the Windows host before adopting this:

- `web-tree-sitter` + prebuilt `.wasm` grammars — symbol extraction works
- `node:sqlite` — built into Node 24, works
- `pnpm` 10.34.5 — installed via `npm -g` (corepack needs admin for
  `C:\Program Files\nodejs`, so it was not used)

## Outstanding

Two items still want a POSIX environment, both far from the current work:

- **F39** — the `curl | sh` installer and `scripts/install-e2e.sh` must be
  exercised on Linux/macOS. CI runners cover this without touching WSL.
- **B2 / eval harness** — SWE-bench task containers. Docker Desktop on Windows
  can host these; if it cannot, this deviation is revisited.

To retire this deviation, fix WSL networking on the host and re-run F0's spike
inside the distro. Nothing in Phases 0–3 depends on it.
