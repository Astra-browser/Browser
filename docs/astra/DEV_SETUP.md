# Dev setup — Linux and Windows (P0-T01, P7-T07)

> Fresh clone? Run `./setup.sh` from the repo root — the same command on Linux
> and Windows (Windows: Git Bash). It checks/installs prerequisites, fetches or
> links the pinned engine, builds the UI + engine, packages the app and verifies
> the package. `./setup.sh --dry-run` prints the plan without building;
> `./setup.sh --check` verifies an existing package.
> On Windows the script bridges to `tools/setup-windows.ps1` (winget + VS Build
> Tools + NSIS, then `forge --os windows` and `package-windows.ps1`).
> `tools/bootstrap.sh` remains for no-sudo Linux environments with deps already
> installed.
>
> Space-saving reuse (no second ESR download/objdir):
> `./setup.sh --reuse-engine /path/to/esr-source --objdir /path/to/objdir`.
> The `engine/` link is re-overlaid from this checkout, so keep it on the same
> ESR pin.

## One-command reproducibility

The supported install path is `./setup.sh` on both build hosts. It is
idempotent, logs each run to `out/setup/setup-<timestamp>.log`, and stops with
the failing step named. `--dry-run` is the fast gate used by CI; it checks the
platform, options and prerequisite status without sudo or a build.

Windows prerequisites are installed through `winget` where a package exists
(Git, Python, Node, Rust, NSIS); Visual Studio Build Tools are installed with
the VCTools workload if `vswhere.exe` is absent. MozillaBuild at
`C:\mozilla-build` is checked but not bundled. The package step produces the
portable zip and the per-user `setup.exe`.

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

Windows uses the sibling PowerShell launcher (the Linux script is unchanged):

```powershell
.\tools\run-dev.ps1              # reuse out\dev-profile
.\tools\run-dev.ps1 -Fresh       # empty profile
.\tools\run-dev.ps1 -- -new-window
```

It runs `engine\obj-astra-windows\dist\bin\firefox.exe` and prints the
`forge build --os windows --jobs 2` command if the binary is missing.

## Versioning the dev/alpha build

Astra's own version lives in `branding/astra.toml`; the Firefox pin in
`upstream.toml` is separate and never changes with it. Bump the `version`
value on every build handed to a tester:

```toml
# branding/astra.toml
version = "0.1.743"
```

`forge overlay` renders it into the `astra.version` pref (About reads it
through `about_info`), and `tools/package-release.sh` uses it for the archive
name and `BUILD.txt`. Verify a build before handing it out:

```sh
python3 tools/marionette-probe/version-probe.py \
  out/release/stage/Astra/firefox     # or the dev build's firefox
```

### Product flags

Each flag is a **build** decision, not a preference: off, the surface is not in
the product. Flags are read at build time, so changing one needs a rebuild.

| Flag | Default | Contains |
|---|---|---|
| `VITE_ASTRA_WORK` | off | Work: the agent environment, its rail switch, canvas and Settings pages (D-48) |
| `VITE_ASTRA_AI` | **off** | Ask Astra, models, dictation, skills, memory, site styles, MCP connections, the AI switch |
| `VITE_ASTRA_ACCOUNT` | **off** | Sign in to Astra, the account foot, plan and credits, the identity group |

```sh
# develop one of them
VITE_ASTRA_AI=true bun run --filter @astra/frame build:chrome
VITE_ASTRA_AI=true VITE_ASTRA_ACCOUNT=true bun run --filter @astra/frame dev
```

A flag that is off removes its Settings pages, its shelf tool and its search
results — there is no disabled control left behind. The shipped build has all
three off.

## Installable release build

```sh
# frame already built with Work off (the default); builds overlay + engine:
./tools/package-release.sh --with-build

# or package the current dist/ without rebuilding:
./tools/package-release.sh
```

Output: `out/release/Astra-<ver>-linux-x86_64.tar.xz` plus its `.sha256`.
The archive is a portable browser folder with `astra-core`, an `install.sh`
(per-user or `--system`), launcher, icons and desktop entry. It contains the
full product with the Work flag off. `mach package` needs three Astra entries
in the packaging manifest (`chrome/astra*`, `mozilla.cfg`, the autoconfig pref,
`distribution/*`, the sidecar) and an `astra/defs.mk`; the script applies both
fixes to the ignored `engine/` tree idempotently.

## Rebuild loop

| Changed | Command | Time |
|---|---|---|
| `ui/app/**` | `bun run --filter @astra/frame build:chrome` | ~7 s |
| `ui/shell/**` | `bun run --filter @astra/shell-hello build` | <1 s |
| `overlay/astra/**`, `patches/**` | `node tools/stage-host-jar.mjs` then `(cd forge/astra-forge && cargo run -q -- overlay)` | <1 s |
| any of the above | `(cd forge/astra-forge && cargo run -q -- build --faster)` | ~7 s |
| `engine/**` (C++/Rust) | `(cd forge/astra-forge && cargo run -q -- build --jobs 2)` | ~20 s+ |

**Never run the engine build without `--jobs 2`**: the gkrust LTO link has
OOM-killed this machine and taken the editor with it (BUILD_TIMES.md).

### Low-memory build (desktop session alive)

The final `gkrust` link defaults to **fat LTO** (`-Clto`), which peaked at
18.3 GB anonymous RSS here and was OOM-killed while the editor and two browsers
held ~13 GB. The rest of the build never needs that much.

- zswap is already enabled on this machine (`/sys/module/zswap/parameters/enabled`
  is `Y`); there is no zram device. Do not add another swap layer.
- `sccache` is already configured by `out/mozconfig.linux`; a resumed build
  reuses it.
- For a probe build, cap the LTO peak by running that one rustc invocation as
  thin LTO. Edit `config/makefiles/rust.mk` line ~121 from
  `cargo_rustc_flags += -Clto$(if ...)` to `+= -Clto=thin`, build, then revert
  the file. Thin LTO reuses the existing bitcode rlibs, so only `gkrust`
  re-links (about 7 minutes here) and the RSS stays under ~6 GB.
- Run the build detached so an editor/harness restart cannot kill the link:
  `setsid nohup env MALLOC_ARENA_MAX=2 nice -n 15 cargo run -q -- build --jobs 2 &`.
  Product builds keep fat LTO; this is a dev-machine RAM cap only.


After `build:chrome` or the shell build, stage before refreshing the dist:
`cargo run -q -- overlay` copies `overlay/astra/` into `engine/astra/`, then
`cargo run -q -- build --faster` links those files into `dist/bin`. Running
`build --faster` before `overlay` leaves the dist symlinks on the previous
hashed bundle and the app boots to "app frame timed out".

## Drive the running browser (Marionette)

Repo Python scripts (`tools/state-check.py`, `tools/contract-runner/run.py`,
`tools/marionette-probe/*.py`, `tools/perf/**/*.py`) are stdlib-only. Shell
entry points (`setup.sh`, `tools/bootstrap.sh`, `tools/package-release.sh`,
`tools/blocker-wiring-check.sh`, `tools/perf/full-suite.sh`) resolve the
interpreter via `tools/venv-python.sh`: `$ROOT/.venv` when present
(`.venv/bin/python` on Linux, `.venv/Scripts/python.exe` on Windows
Git-Bash), else system `python3`/`python`. Create it with
`python -m venv .venv`, then activate for direct probe runs:

```sh
source .venv/bin/activate          # Linux
.\.venv\Scripts\Activate.ps1       # Windows PowerShell
```

Playwright cannot attach to this build (it needs `-juggler-pipe`; our ESR
build does not speak it). Use the in-tree harnesses:

```sh
python3 tools/marionette-probe/headed-probe.py /tmp/p out/shot   # launch + state + screenshot
python3 tools/marionette-probe/framecheck2.py                    # frame-by-frame boot check (PID-matched)
python3 tests/contract/shell_app_chrome.py                       # 17 live checks
python3 tools/perf/stress/devtools_probe.py                      # DevTools: real tab, toggle, container, tab close
```

## Optional Rust core

The shell calls `Boot.launchCore` on mount. `forge build` compiles
`astra-core` and installs it in `dist/bin`, and the shell picks it up from
beside the browser binary automatically. `astra.core.command` overrides that
path (useful for a debug build:
`user_pref("astra.core.command", "/absolute/path/to/target/debug/astra-core");`).
No binary is an honest `unavailable`. The browser passes
`--db <profile>/astra/core.sqlite`; override with `astra.core.database`.
Probe: `tools/perf/stress/metadata_restore_probe.py` (set
`ASTRA_METADATA_AUTODETECT=1` to exercise the packaged path). See
`docs/astra/CORE_STORE.md`.

## P4 stage dock

Native tabs (always on) dock `#tabbrowser-tabbox` over the Astra content slot.
`Content.mountNative` marks `data-astra-native-mounted`; there is no switch and
no standalone fallback. The geometry probe is
`tools/perf/stress/gbrowser_stage_probe.py`; the native tab mapping probe is
`tools/perf/stress/gbrowser_tabs_probe.py`.

## P6b permission prompt

A page geolocation request shows the app's own `PagePermissionPrompt`; camera
and microphone requests reach the same prompt through
`patches/ASTRA-0008-astra-webrtc-prompt.patch` (WebRTC actor). Live proofs:
`tools/perf/stress/permission_prompt_probe.py` (geolocation, `Services.perms`,
the page's own `permissions.query`) and
`tools/perf/stress/webrtc_permission_probe.py` (getUserMedia with fake devices:
allow/deny/once/dismiss/auto-allow, real stream or `NotAllowedError`).
