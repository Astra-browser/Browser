# Windows engine-build port (scaffold, UNVERIFIED)

Status: scaffold only. No Windows Firefox build has been attempted in this
repo. Linux remains the only verified path. Everything below is additive;
Linux behaviour is byte-identical when `--os linux` is used.

## Prerequisites (to install, not yet verified here)

- Visual Studio 2022 (MSVC + Windows SDK) — Firefox's supported toolchain.
- MozillaBuild shell + Python 3 (ships with MozillaBuild).
- Clang (via VS installer / Mozilla requirements), NASM, sccache.
- Rust (rustup, stable), Git, curl, tar, gpg.
- Upstream docs: Firefox ESR 153 source-tree build requirements for Windows
  (verify before any real `mach build`; linux package lists do NOT apply).

## New commands

```sh
# render the Windows mozconfig scaffold
cargo run -q -p astra-forge -- config --os windows --branding astra
# output: out/mozconfig.windows

# linux path unchanged
cargo run -q -p astra-forge -- config --os linux --branding astra
# output: out/mozconfig.linux (byte-identical to before)
```

Template: `config/mozconfig.windows` (mirrors `config/mozconfig.linux`
with `TODO(windows-port)` markers for every flag that still needs
confirmation on a real Windows toolchain: objdir name, backgroundtasks,
sccache, sandbox/crashreporter/updater defaults).

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
