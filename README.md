# Astra

Astra is a native, privacy-first web browser built from **Firefox ESR 153.6.0**
plus a patch series, a chrome overlay and a Rust sidecar. The browser UI is a
first-party chrome document; a host layer wires every surface to the engine.

Repository: <https://gitlab.com/kyoiske/astra>

## Requirements (Linux x86_64)

This is the only supported build target today.

| Need | Why |
|---|---|
| 8 GB RAM minimum, 16 GB+ recommended | the gkrust LTO link peaks near 10 GB |
| ~30 GB free disk | engine source ~6 GB, objdir ~16 GB, Rust targets/caches ~8 GB |
| `git`, `curl`, `tar`, `gpg`, `patch`, `python3` | fetch, verify and assemble the source tree |
| Rust toolchain (`cargo`, 1.90+) | `astra-forge` and the `astra-core` sidecar |
| [Bun](https://bun.sh) 1.3+ | builds the Svelte UI bundle |
| Firefox build dependencies | `clang`, GTK3, dbus-glib, ALSA, X11/Wayland headers, … |

The first engine build needs the Firefox prerequisites. On a fresh distro run
once inside the fetched engine tree:

```sh
cd engine && ./mach bootstrap --application-choice=browser
```

(`./mach bootstrap` asks for `sudo` to install distro packages.) Everything
else is installed by the steps below.

## Clone and build (one command)

```sh
git clone https://gitlab.com/kyoiske/astra.git
cd astra

# once per machine: import Mozilla's release key so `forge fetch` can verify
# the upstream tarball signature
gpg --keyserver hkps://keyserver.ubuntu.com \
    --recv-keys 14F26682D0916CDD81E37B6D61B7B526D98F0353

./tools/bootstrap.sh
```

`tools/bootstrap.sh` runs, in order:

1. builds `forge/astra-forge` (the repo's zero-dependency build tool),
2. downloads and GPG-verifies Firefox ESR 153.6.0, extracts it to `engine/`,
3. renders `out/mozconfig.linux` from `config/mozconfig.linux`,
4. installs UI dependencies and builds the chrome bundle into
   `overlay/astra/chrome/app`,
5. applies the overlay and the `patches/` series to `engine/`,
6. builds `engine/obj-astra-linux/dist/bin/firefox` and the `astra-core`
   sidecar.

The first full build takes roughly **70 minutes** on 16 threads. Later builds
are incremental: `--faster` is a few seconds for overlay/UI changes. Builds
default to `--jobs 2` because a full-parallel link has OOM-killed 31 GB
machines; override with `JOBS=8 ./tools/bootstrap.sh` on a headless host.

Run the build:

```sh
./tools/run-dev.sh            # reuse out/dev-profile (settings persist)
./tools/run-dev.sh --fresh    # start from an empty profile
```

### Manual equivalent

```sh
cargo build --release --manifest-path forge/astra-forge/Cargo.toml
FORGE=forge/astra-forge/target/release/astra-forge

$FORGE fetch                 # download + verify + extract engine/
$FORGE config --os linux --branding astra
( cd ui && bun install --frozen-lockfile )
bun run --filter @astra/frame build:chrome
$FORGE overlay               # copy overlay/astra + apply patches/*.patch
$FORGE build --jobs 2        # engine + astra-core sidecar
```

`engine/`, `out/` and build outputs are git-ignored: they are generated from
the pinned tarball in `upstream.toml`, the tracked `patches/` series, the
tracked `overlay/` and the UI sources.

## Installable release build

```sh
./tools/package-release.sh --with-build   # overlay + engine build + package
./tools/package-release.sh                # package the existing build
```

Output: `out/release/Astra-<version>-linux-x86_64.tar.xz` and its `.sha256`.
Extract it and run `./install.sh` (per-user) or `sudo ./install.sh --system`.
The archive is the full product with the Work flag off (Beta 1 rule). See
`docs/astra/DEV_SETUP.md`.

## Verification

```sh
python3 tools/state-check.py        # task-lock registry consistency
./tools/brand-lint.sh               # branding gate
$FORGE lint                         # patch-series health
bun run --filter @astra/frame check # UI types, lint and unit tests
tools/perf/full-suite.sh --skip-build   # contracts + live probes + benches
```

Live browser probes drive the packaged build through Marionette; see
`docs/astra/TESTING.md`.

## Repository layout

| Path | Contents |
|---|---|
| `ui/` | Svelte 5 + TypeScript browser UI (Bun workspace) |
| `overlay/astra/` | chrome document, host modules, prefs, branding staged into `engine/astra/` |
| `patches/` | the upstream patch series (`ASTRA-NNNN`) applied by `forge overlay` |
| `crates/` | Rust workspace: core, store, IPC, proto, blocker, tasks, notes, time, … |
| `blocker/` | in-tree ad/tracker blocker component (C++ + Rust) |
| `forge/astra-forge/` | build/fetch/overlay/lint tool |
| `config/`, `branding/`, `upstream.toml` | mozconfig template, brand values, pinned upstream |
| `tests/`, `tools/` | contract tests, probes, lint and release scripts |
| `docs/astra/` | scope, state, decisions, dev setup and subsystem contracts |

## Troubleshooting

- **`gpg: Can't check signature`** — import Mozilla's key (command above).
  `forge fetch` refuses to continue without a verified tarball.
- **`engine/ source absent`** — run `$FORGE fetch`.
- **`mach` complains about missing system libraries** — run
  `(cd engine && ./mach bootstrap --application-choice=browser)`.
- **OOM during the link** — keep `JOBS=2`, close heavy apps, or build on a
  headless host. Never link `libxul` at `-j16` on a 31 GB desktop.
- **Blank window after an overlay edit** — run `$FORGE overlay` *before*
  `$FORGE build --faster`; otherwise dist symlinks point at the old bundle.

The authoritative development notes are in `docs/astra/DEV_SETUP.md`, and the
current scope contract is `docs/astra/SCOPE.md`.
