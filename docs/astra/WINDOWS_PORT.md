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

- **PASS 2026-11-14 10:35**: unpatched baseline `firefox.exe` (779,264 bytes)
  and `xul.dll` (180,012,544 bytes); `firefox.exe --version` reports
  `Mozilla Firefox 153.6.0esr`. The final run used `-j20`, wall time 48:49
  (2928 s). Full history and sccache numbers: `docs/astra/BUILD_TIMES.md`.
- The path to that build required three Windows fixes: cross-drive objdir
  (`ASTRA-0015`), NSPR clang-23 casts (`ASTRA-0016`), and NASM 2.16.03 instead
  of 3.02 for libvpx.
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

### First patched build and live probes (2026-11-14)

- `forge import --os windows` applied ASTRA-0001..0013, skipped 0014, and
  treated 0015/0016 as already applied.
- `forge overlay --os windows` staged the overlay, blocker and Astra branding;
  passkeys stayed absent.
- `mach configure` with `--with-branding=astra/branding` and
  `--with-wasi-sysroot=D:/astra-build/wasi-34/wasi-sysroot-34.0` passed.
- Patched `mach build` **PASS** 2026-11-14 13:05, wall 15:08, thin Rust LTO;
  `xul.dll` 182,513,664 bytes.
- `tools/marionette-probe/version-probe.py <windows firefox.exe>` **8/8 PASS**:
  Astra version 0.1.745, `about_info` reports `Windows_NT 10.0` / `x86_64`,
  app booted, Settings -> About shows `Version 0.1.745`.
- `tools/windows/sidecar-probe.py` **5/5 PASS**: the shell finds
  `astra-core.exe` beside the browser, reports `data-core=running`, the process
  is alive, `ProfD/astra/core.sqlite` is created, and the sidecar stops with the
  browser.
- `mach build faster` after an overlay is **10-13 s**.

### Headed visual probe (2026-11-14)

`tools/marionette-probe/headed-probe.py` is OS-aware now: it picks
`engine/obj-astra-windows/dist/bin/firefox.exe` on Windows, launches a visible
window, waits for the app frame, and captures the real top-level window through
Win32 `PrintWindow` (GDI, stdlib only) in addition to Marionette's own
screenshot. Linux keeps the Hyprland `grim` path and the
`obj-astra-linux` default; `--binary`, `--port` and `--keep-open` are explicit.

Live run on the Windows build: **10/10 PASS**. `appReady=host`, shell relay 132
messages with no error, frame 1266x853, sidebar 240x837, address field and tab
row present, zero real console errors; capture 1600x1075 at 125% DPI
(2201 colours, 31.6% locally varied pixels). Evidence in
`out/headed-windows/` (`window.png`, `shot.png`, `snap.json`).

### Blocker, tabs and Settings surface probes (2026-11-14)

The core surface probes now choose the platform build and work from the
repository root on either OS:

| Probe | Windows result | What it proves |
|---|---|---|
| `tools/marionette-probe/blocker-probe.py` | **21/21 PASS** | seed install reaches `active` (200,392 rules, 81 lists), catalog/configure round-trip, the native hook cancels the ad image on a loopback page, the actor hides the cosmetic element, counters/reset work, and the Settings blocker section renders |
| `tools/marionette-probe/tabs-probe.py` | **PASS** | address search loads in tab 1, a new tab starts blank, tab 2 takes its own address, the model has both rows, and switching back restores tab 1's live page |
| `tools/marionette-probe/settings-native-probe.py` | **50/50 PASS** | every mapped preference writes through the Host API, reads back, reaches the app, and does not invent Firefox prefs for Astra-only settings |

The tabs probe now reads the selected native tab (`gBrowser.selectedBrowser`)
instead of relying on the Linux slot marker, and the scripts use
`shutil.rmtree` plus the platform binary name. Linux keeps the same checks and
the `obj-astra-linux` default.

### sccache (verified 2026-11-14)

- One detached sccache 0.19.0 server listens on `127.0.0.1:4226`; its parent
  process can exit and the server stays alive.
- Cache at `D:\astra-build\sccache` (10 GiB max), diagnostics at
  `D:\astra-build\sccache\error.log`.
- `forge build --os windows` sets `SCCACHE_LOG=warn`,
  `SCCACHE_ERROR_LOG`, `SCCACHE_IDLE_TIMEOUT=0` and pre-starts the server.
- `tools/windows/sccache-smoke.ps1` PASS: C/C++ hit, Rust hit, 16 concurrent
  compiles, server alive afterwards.
- Real engine build evidence: the baseline first pass executed 1,985 compiles
  and wrote 1,952 objects with 0 cache errors. The patched build executed 510
  compiles with **458 hits and 43 misses (91.42%)**, 0 cache errors and 0
  compilation failures.
- The first pass over new sources is misses; the next build of the same
  sources hits.
- The earlier "connection forcibly closed" errors happened when a forced
  build-tree stop also killed the server. Do not `taskkill /T` the sccache
  server; `forge build` now starts it detached and keeps it idle-alive.

### Dev Rust LTO (thin)

The first patched `gkrust` with fat LTO crashed at 97:43 with
`0xC0000409` (STATUS_STACK_BUFFER_OVERRUN) after reaching ~11.6 GB. Dev builds
use thin LTO instead:

```powershell
.\tools\windows\thin-lto.ps1            # dev: -Clto=thin
.\tools\windows\thin-lto.ps1 -Revert    # release: -Clto (fat)
```

The helper edits only `engine/config/makefiles/rust.mk`. `forge fetch` replaces
the engine tree, so re-run it after a fetch. Thin LTO shortens the `gkrust`
link and keeps its peak near 6 GB; release builds must stay on fat LTO.

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
