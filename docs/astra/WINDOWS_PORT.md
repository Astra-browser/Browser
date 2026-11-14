# Windows engine-build port

Status: **W0 toolchain verified; first native build in progress (2026-11-14).**
MozillaBuild, the VS2022 C++/ATL/MFC components, clang-cl, NASM, GNU make,
cbindgen, the Windows App SDK 2.2 redistributable and the `windows` 0.62.2 crate
source are staged. `mach configure` completes with the objdir on `D:`.
Linux remains the reference platform; every Windows-only change is additive or
guarded by `--os windows` / `cfg(windows)`.

> Plan and owner decisions: `docs/astra/WINDOWS_MASTER_PLAN.md` (D-51).

## Prerequisites (to install, not yet verified here)

- Visual Studio 2022 (MSVC + Windows SDK) — Firefox's supported toolchain.
- MozillaBuild shell + Python 3 (ships with MozillaBuild).
- Clang (via VS installer / Mozilla requirements), NASM, sccache.
- Rust (rustup, stable), Git, curl, tar, gpg.
- Upstream docs: Firefox ESR 153 source-tree build requirements for Windows
  (verify before any real `mach build`; linux package lists do NOT apply).

## New commands

```sh
# render the Windows mozconfig (objdir defaults to @TOPSRCDIR@/obj-astra-windows)
cargo run -q -p astra-forge -- config --os windows --branding astra \
  --objdir E:/Astra/engine/obj-astra-windows
# output: out/mozconfig.windows

# patch series / overlay / build with the Windows platform selected
cargo run -q -p astra-forge -- import --os windows
cargo run -q -p astra-forge -- overlay --os windows
cargo run -q -p astra-forge -- build --os windows --jobs 2

# linux path unchanged
cargo run -q -p astra-forge -- config --os linux --branding astra
# output: out/mozconfig.linux (byte-identical to before)
```

Template: `config/mozconfig.windows` mirrors `config/mozconfig.linux`.
The remaining unverified flags are tracked in the section below; `OS: linux`
patches (ASTRA-0014) are skipped by `import`/`overlay --os windows`, and
`OS: windows` patches (ASTRA-0016) are skipped on Linux.

## W0 verified toolchain (2026-11-14)

| Tool | Version / path |
|---|---|
| Windows | 11 Home Single Language, build 26300, x64 |
| Visual Studio | Community 17.14.45, MSVC 14.44.35207, Windows SDK 10.0.26100 |
| ATL/MFC | `Microsoft.VisualStudio.Component.VC.ATLMFC` + `VC.ATL`, installed 2026-11-14 |
| clang-cl | LLVM 23.1.5 at `C:\Program Files\LLVM\bin\clang-cl.exe` |
| MozillaBuild | 4.2.1 at `C:\mozilla-build` (MSYS2 `msys2/usr/bin`) |
| GNU make | 4.4.1 (winget `ezwinports.make`; MozillaBuild 4.2.1 does not bundle it) |
| Python | 3.12.10 (MozillaBuild `C:\mozilla-build\python3`) |
| NASM | **2.16.03** at `D:\astra-build\nasm-2.16.03\nasm-2.16.03` for builds (3.02 at `C:\tools\nasm` crashes the pinned libvpx `dequantize_mmx.asm`); set `ASTRA_NASM_DIR` |
| cbindgen | 0.29.4 (`cargo install cbindgen --locked`) |
| sccache | 0.19.0, cache at `D:\astra-build\sccache` |
| Windows App SDK | 2.2.0 redistributable, SHA-256 pinned by the tree; DLLs staged at `D:\astra-build\windowsappsdk\winappsdk-x86_64-pc-windows-msvc` |
| `windows` crate | 0.62.2 source at `D:\astra-build\windows-rs\windows-0.62.2` |
| Defender exclusions | `C:\mozilla-build`, `E:\Astra`, `D:\astra-build`, `C:\Users\Rem\.mozbuild` |
| Git | `core.longpaths=true`, repo/engine `core.autocrlf=false`, `*.patch` pinned to LF |

### Configure recipe (verified)

`mach configure` must run inside MozillaBuild so its MSYS `sh`, `make`, `perl`
and Python are on PATH. The objdir lives on `D:`. Because the source is on `E:`,
the objdir is exposed as an `E:` junction
(`E:\Astra\engine\obj-astra-windows` -> `D:\astra-build\obj-astra-windows`) and
`patches/ASTRA-0015-windows-cross-drive-objdir.patch` makes the Visual Studio
backend emit an absolute MSYS path when `os.path.relpath` crosses drives.

Environment used:

```sh
export PATH="/c/Users/Rem/AppData/Local/Microsoft/WinGet/Packages/ezwinports.make_Microsoft.Winget.Source_8wekyb3d8bbwe/bin:/c/Program Files/LLVM/bin:/d/astra-build/nasm-2.16.03/nasm-2.16.03:/c/tools/nasm:$PATH"
export MOZCONFIG=/e/Astra/out/mozconfig.windows.local
export SCCACHE_DIR=/d/astra-build/sccache
export MOZ_WINDOWS_APP_SDK_DIR=/d/astra-build/windowsappsdk/winappsdk-x86_64-pc-windows-msvc
export MOZ_WINDOWS_RS_DIR=/d/astra-build/windows-rs/windows-0.62.2
export ASTRA_NASM_DIR=D:/astra-build/nasm-2.16.03/nasm-2.16.03
cd /e/Astra/engine && ./mach configure
```

Result: `Configure complete!` after 37 s. The generated backends are
`RecursiveMake`, `FasterMake`, `VisualStudio` and `Clangd`; the VS solution is
written under the D: objdir.

`forge doctor --os windows` is green: curl, tar, gpg, git, rustc, Python, Bun,
clang-cl, NASM, sccache, MozillaBuild, make and all 12 Windows mozconfig lines
pass. `forge import --check --os windows` classifies the 15 patches and skips
`ASTRA-0014` (`OS: linux`); `ASTRA-0015`/`ASTRA-0016` are the Windows-only
fixes. `forge doctor --os linux` and `forge config --os linux` remain green.

### Baseline build state

- First unpatched baseline build started **2026-11-14 06:54** with
  `./mach build --jobs 2` (the standing OOM rule). Result is recorded in
  `docs/astra/BUILD_TIMES.md` when it completes.
- The baseline mozconfig uses `--without-wasm-sandboxed-libraries` because the
  pinned tree's WASI sysroot is not installed yet. **A product build must not
  use this line**; W0.4/W1 must add a WASI sysroot and remove it.
- `dxcompiler.dll` is not picked up by `bootstrap_path`, so configure warns that
  WebGPU is disabled. The DLL exists in the installed SDK at
  `C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\dxcompiler.dll`;
  staging the `dxc-x86_64-pc-windows-msvc` toolchain (or a reviewed equivalent)
  is required before claiming WebGPU support.
- The WASI sysroot is staged at `D:\astra-build\wasi\wasi-sysroot` (20.0).
  Product builds set `WASI_SYSROOT` and remove the baseline-only
  `--without-wasm-sandboxed-libraries` line.

### sccache (verified 2026-11-14)

- One detached sccache 0.19.0 server listens on `127.0.0.1:4226`; its parent
  process can exit and the server stays alive.
- Cache at `D:\astra-build\sccache` (10 GiB max), diagnostics at
  `D:\astra-build\sccache\error.log`.
- `forge build --os windows` sets `SCCACHE_LOG=warn`,
  `SCCACHE_ERROR_LOG`, `SCCACHE_IDLE_TIMEOUT=0` and pre-starts the server.
- `tools/windows/sccache-smoke.ps1` PASS: C/C++ hit, Rust hit, 16 concurrent
  compiles, server alive afterwards.
- Real engine build evidence: 46 compiles executed, 45 cache writes, 0 cache
  errors, 0 compilation failures. The first pass is misses; the next build of
  the same sources hits.
- The earlier "connection forcibly closed" errors happened when a forced
  build-tree stop also killed the server. Do not `taskkill /T` the sccache
  server; `forge build` now starts it detached and keeps it idle-alive.

## What remains UNVERIFIED (intentionally left for later)

See the blocker list in the port report; summary:

1. `setup.sh`: apt/dnf/zypper/pacman + sudo + `/etc/os-release` distro
   detection; `uname -m` check; `mach bootstrap --application-choice=browser`
   Linux package flow; hardcoded `forge config --os linux`,
   `MOZCONFIG=out/mozconfig.linux`, `obj-astra-linux` paths.
2. `tools/bootstrap.sh`: Linux package assumptions (`gpg`, `cp`, `tar -xJf`
   flags), `forge config --os linux`, final `engine/obj-astra-linux/...` path.
3. `forge build`: defaults `MOZCONFIG` to `out/mozconfig.linux` and hardcodes
   `engine/obj-astra-linux/dist/bin` for the `astra-core` install; no `windows`
   objdir handling yet.
4. `forge import` vendor step: defaults `MOZCONFIG` to `out/mozconfig.linux`.
5. `forge overlay`: uses `cp -a` (needs a Windows-compatible copy path).
6. `forge fetch`: `curl`/`tar`/`gpg`/`git` invocations assume a Unix shell
   environment (on Windows: run under MozillaBuild/Git-Bash or port to
   PowerShell equivalents).
7. `tools/run-dev.sh`: hardcoded `engine/obj-astra-linux/dist/bin/firefox`.
8. `tools/package-release.sh`: `DIST=engine/obj-astra-linux/dist`,
   `MOZCONFIG=out/mozconfig.linux`, `firefox-*.en-US.linux-x86_64.tar.xz`
   glob, `linux-x86_64` archive name, Linux `.desktop`/AppArmor/install.sh
   payload — no Windows installer/zip path yet.
9. `config/mozconfig.windows` itself: mirrored flags, none verified against
   the ESR 153.6.0 Windows configure set; needs a real
   `mach configure` + `mach build` run under MozillaBuild.
10. CI/docs: `DEV_SETUP.md` and related runbooks describe Linux only.

## Standing GPU rule (windows-port)

This machine has an NVIDIA RTX 3050 (4 GB) plus Intel integrated graphics.
The rule for all Windows-port work: anything the NVIDIA GPU can do faster
and better goes to the NVIDIA GPU — never the Intel iGPU.

- Runtime/browser graphics: the built browser must use the discrete GPU
  (WebRender compositor, video decode, canvas/WebGL). OS-level setting:
  Windows GPU preference for the built `firefox.exe` → High performance,
  and/or NVIDIA Control Panel → preferred GPU = NVIDIA. Do not add fake
  `ac_add_options` GPU flags to the mozconfig — Firefox has no such build
  knob; this is a runtime/OS preference, verified with a live probe.
- Build/compile steps (`cl`, `clang`, rustc, link) are CPU-bound and stay on
  CPU — the GPU cannot compile C++/Rust. No build script may claim GPU
  acceleration for these; the GPU rule covers graphics/GPU-capable work only.
- Any new script or doc that touches rendering, screenshots, video, or
  performance probes must state which GPU it targets (NVIDIA) and how it
  was verified (e.g. `about:support` compositing/GPU section via probe).

## Verification done for this scaffold

- `cargo check --manifest-path forge/astra-forge/Cargo.toml` passes.
- `forge config --os windows` renders `out/mozconfig.windows`;
  `forge config --os linux` output is unchanged.
- No `.sh` Linux logic was modified; no venv created; no fetch/build run.
