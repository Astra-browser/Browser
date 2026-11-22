# One-command setup and reproducibility (P7-T07)

The supported install path is **one command**:

```sh
./setup.sh
```

It is the same command on Linux x86_64 and Windows 11 x64 (Windows: run it from
Git Bash). The script detects the host and either runs the Linux package/build
pipeline or bridges to `tools/setup-windows.ps1`.

## What the command does

1. Checks the host and prerequisites.
2. Installs what the platform package manager can provide:
   - Linux: `apt-get` / `dnf` / `zypper` / `pacman` packages, Rust, Bun.
   - Windows: Git, Python, Node, Rust, Bun, Visual Studio Build Tools (VCTools)
     and NSIS through `winget` where a package exists.
3. Builds `astra-forge`.
4. Fetches and verifies Firefox ESR 153.6, or links an existing matching tree.
5. Renders the platform mozconfig.
6. Builds the chrome UI and regenerates the host jar manifest.
7. Applies the overlay and patch series.
8. Builds the engine and `astra-core`.
9. Packages the platform release and verifies it.
10. Writes a timestamped log under `out/setup/`.

## Space-saving reuse

A second 22 GB engine tree/objdir is not required:

```sh
./setup.sh --reuse-engine /path/to/matching-esr-source --objdir /path/to/objdir
```

- `--reuse-engine` creates the `engine/` link instead of fetching ESR. The tree
  is still overlaid from this checkout, so it must be the same ESR pin.
- `--objdir` keeps the large build directory on a drive with room.
- `engine/`, `out/`, Rust targets and the staged chrome assets stay ignored.
  Fixes belong in `overlay/`, `patches/`, `ui/`, `crates/`, `tools/` or this
  script — never in generated engine output.

## Dry run and CI gate

```sh
./setup.sh --dry-run
```

The dry run prints the host, distro, options, build plan and prerequisite
status without sudo, installation or a build. `tests/contract/setup_model.mjs`
pins the command, options, Windows bridge, packaging and CI wiring. The
`setup-dry-run` CI job runs the dry run on `ubuntu-latest` and
`windows-latest`.

## Outputs

| Host | Output |
|---|---|
| Linux | `out/release/Astra-<version>-linux-x86_64.tar.xz` (+ `.sha256`) |
| Windows | `out/release/Astra-<version>-windows-x86_64.zip` (+ `.sha256`) and `Astra-<version>-windows-x86_64-setup.exe` |

Windows also keeps `firefox.exe` beside `astra.exe` for engine compatibility;
`astra.cmd` launches the portable build with its own profile.

## Failure handling

- The script stops at the first failing step and prints `FAILED: <step>`.
- Every run has a log in `out/setup/setup-<timestamp>.log`; the path is printed
  on failure.
- Re-running is idempotent: fetched/linked sources, UI installs, overlay and
  packaging all tolerate an existing tree.

## Known constraints

- macOS is out of scope (P10); the script refuses it explicitly.
- MozillaBuild is checked at `C:\mozilla-build` but is not downloaded by the
  script; install it once per Windows host.
- A first full engine build still takes roughly 70 minutes on 16 threads; use
  `JOBS=2` unless the machine is headless and has RAM to spare.
- Release signing and the update channel remain owner decisions.

## Verification record

See the `P7-T07` row in `docs/astra/STATE.md` for the measured Windows build,
the dry-run gate and the clone test.
