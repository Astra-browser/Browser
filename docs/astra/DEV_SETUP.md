# Dev setup — Linux (P0-T01, first facts 2026-11-01)

## Machine

- CPU: 16 threads · RAM: 31 GiB · Disk: 158 GiB free on `/home` — adequate for
  engine work (plan advises big disk/RAM; exact Firefox ESR 153 requirements
  still UNVERIFIED — confirm against official build docs in P1-T01).
- `sccache`/`ccache`: not installed yet (P1-T04).

## Toolchains (observed)

| Tool | Found | Expected by source snapshot |
|---|---|---|
| `rustc`/`cargo` | 1.99.1 | 1.95.0 (`rust-toolchain.toml`) — `rustup` will pin per-project |
| `bun` | 1.4.4 | source uses `pnpm@11.17.0` + Node ≥ 24; Bun migration is P3-T01 work |
| `python3` | 14.8 | needed by `mach` (verify version bound in P1) |
| `gcc` | 16.2.1 | build dep (verify) |
| `clang` | 23.x present | build dep (verify) |
| `mach` | **absent** | arrives with `forge fetch` (engine source) |

## Next steps (P1-T01…T04)

1. Verify current Firefox ESR 153 build prerequisites from official docs
   (do not trust this file's guesses).
2. `forge fetch` → `forge config` → first full Linux build; record
   time/disk/RAM in `docs/astra/BUILD_TIMES.md`.
