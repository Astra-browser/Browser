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

## Run the dev build (2026-11-03)

```sh
cd /home/rem/Projects/Astra
./tools/run-dev.sh            # reuse out/dev-profile (settings persist)
./tools/run-dev.sh --fresh    # empty profile
./tools/run-dev.sh -- --new-window   # extra flags pass to Firefox
```

It runs `engine/obj-astra-linux/dist/bin/firefox` with `-no-remote` and a
profile in `out/dev-profile`, and prints the build command if the binary is
missing.

## Rebuild loop

| Changed | Command | Time |
|---|---|---|
| `ui/app/**` | `bun run --filter @astra/frame build:chrome` | ~7 s |
| `ui/shell/**` | `bun run --filter @astra/shell-hello build` | <1 s |
| `overlay/astra/**`, `patches/**` | `(cd forge/astra-forge && cargo run -q -- overlay)` | <1 s |
| any of the above | `(cd forge/astra-forge && cargo run -q -- build --faster)` | ~7 s |
| `engine/**` (C++/Rust) | `(cd forge/astra-forge && cargo run -q -- build --jobs 2)` | ~20 s+ |

**Never run the engine build without `--jobs 2`**: the gkrust LTO link has
OOM-killed this machine and taken the editor with it (BUILD_TIMES.md).

## Drive the running browser (Marionette)

Playwright cannot attach to this build (it needs `-juggler-pipe`; our ESR
build does not speak it). Use the in-tree harnesses:

```sh
python3 tools/marionette-probe/headed-probe.py /tmp/p out/shot   # launch + state + screenshot
python3 tools/marionette-probe/framecheck2.py                    # frame-by-frame boot check (PID-matched)
python3 tests/contract/shell_app_chrome.py                       # 17 live checks
```

## Optional Rust core

The shell calls `Boot.launchCore` on mount with `astra.core.command`. It is
empty by default, so the browser runs without a core and answers
`unavailable`. For a dev core, point it at the binary in the profile
(`user_pref("astra.core.command", "/absolute/path/to/astra-core");`) and
restart. The `out/sidecar-stub` harness is the current test double; there is
no packaged core binary yet.

## P4 stage dock (spike)

`astra.gbrowser.enabled` (default false) docks the native
`#tabbrowser-tabbox` over the Astra content slot. It is inert until
`Content.mountNative` marks `data-astra-native-mounted`; flipping the pref
alone must not cover a working page. The geometry probe is
`tools/perf/stress/gbrowser_stage_probe.py`; the native tab mapping probe is
`tools/perf/stress/gbrowser_tabs_probe.py`.
