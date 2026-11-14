# Build times — Linux (P1-T04, closed 2026-11-01)

Machine: 16 threads · 31 GiB RAM · 7 GiB swap · NVMe (`/home`).
Mozconfig: `out/mozconfig.linux` (unofficial branding) + `--enable-release`,
`--with-ccache=sccache`, sccache 0.19.0, `SCCACHE_CACHE_SIZE=30G`.

## First full build (release-like, ESR 153.6.0 + ASTRA-0001 + overlay)

- **Wall span, first compile to binary: ~70 min**, assembled incrementally
  across three resumed `make` runs (env interruptions, no work lost):
  ~6 min → wrapper death; ~14 min → host reboot; remainder incl.
  link+package after `-j8` resume. A clean-tree single-shot number was not
  measured; treat ~70 min as the planning figure for this machine.
- **Result:** `engine/obj-astra-linux/dist/bin/firefox` →
  `Mozilla Firefox 153.6.0esr`, runs, renders `chrome://astra/hello.html`
  (P1-T05 full-build proof, verified in GUI 2026-11-01).
- **Footprint:** objdir **16 GB**, sccache **2.5 GB**, engine source (+ baseline
  git) **5.6 GB**. `/home` free: 151 GB → 169 GB across the day (other churn
  dominates; build inputs are the three figures above).

## OOM incident (recorded so it is not repeated)

- `-j16` release build OOM-killed the box (journal proof; VS Code died too)
  while ~19 GB was otherwise occupied. **Rule: cap at `-j8` on 31 GB machines**
  when the desktop session is alive (fits in ~26 GB free + 7 GB swap; the
  `libxul` link alone peaks near 10 GB). `forge build` accepts `--jobs N`;
  default to 8 until a dedicated build host exists (P8 CI).
- 2026-11-02: `-j6` still killed the IDE — single gkrust LTO rustc hit ~11 GB
  RSS with swap fully exhausted (7/7 GB), VS Code renderers died. Killed build,
  zeroed sccache (34 MB, 0% hits), restarted `nice -n 10 forge build --jobs 2`.
  **Rule hardened: daily-driver builds use `--jobs 2` + nice while the desktop
  session is alive; `-j8` only with the IDE closed or on a headless host.**

## Fast dev loop (U-02 RESOLVED)

- `./mach build faster` (and `forge build --faster`): **~2 s no-op**;
  **~1.7 s** after touching overlay frontend files.
- Overlay chrome files land in `dist/` as **symlinks to `engine/astra/`**
  (observed: `dist/bin/chrome/astra/.../hello.html -> engine/astra/...`), so
  frontend iteration is near-instant and works fine with the tarball-sourced
  tree. Edit `overlay/astra/**`, run `forge overlay`, run
  `forge build --faster`, reload. U-02 closed without needing the git-tree
  fallback.

## Artifact builds (U-03 NOT TRIALED — deliberate)

- Full builds work and the incremental loop is 2 s, so artifact mode buys
  nothing right now at the cost of a separate toolchain download + clobber
  cycle. Revisit only if clean-build iteration becomes the bottleneck
  (e.g. new contributors without sccache).

## Commands

- `forge config --os linux --branding unofficial` → `export MOZCONFIG=…`
- `forge build [--faster] [--jobs N]` (defaults MOZCONFIG/SCCACHE_DIR when unset)
- `forge doctor` (flags vs pinned source) · `forge lint` (patch headers)
- Watch a build: `tail -n 20 out/build-p1t04.log`

## Windows 11 x64 baseline (W0, started 2026-11-14)

Machine: 16 threads · 31.7 GiB RAM · source `E:\Astra`, objdir
`D:\astra-build\obj-astra-windows` exposed through the
`E:\Astra\engine\obj-astra-windows` junction. Toolchain: MozillaBuild 4.2.1,
VS2022 17.14 + MSVC 14.44 + SDK 10.0.26100 + ATL/MFC, clang-cl 23.1.5, GNU
make 4.4.1, NASM 2.16.03 (3.02 crashes libvpx assembly), cbindgen 0.29.4,
sccache 0.19.0.
Mozconfig: local `out/mozconfig.windows.local` (unofficial branding,
`--enable-release`, `--with-ccache=sccache`, `--jobs 2`; baseline only uses
`--without-wasm-sandboxed-libraries` until a WASI sysroot is installed).

| Step | Result |
|---|---|
| `mach configure` | PASS, 37 s; RecursiveMake + FasterMake + VisualStudio + Clangd backends written |
| first `mach build --jobs 2` | stopped after 25 s at `gfx/layers/d3d11/genshaders.py` cross-drive `os.path.relpath`; fixed in ASTRA-0015 |
| second build | stopped after 4 min 42 s: NSPR `w95sock.c` pointer types under clang 23 (fixed in ASTRA-0016) and an sccache server connection reset (server restarted) |
| third build | reached `gkrust` fat-LTO completion in ~78 min, then stopped on `prsocket.c`/`ntmisc.c`/`w95io.c` NSPR casts; fixed in ASTRA-0016 |
| fourth build | reached C++ `browser/components` and `media/libvpx`, then NASM 3.02 crashed `dequantize_mmx.asm` with `0xC0000005`; reconfigured with NASM 2.16.03 |
| fifth build | **PASS** 2026-11-14 10:35, wall 48:49 (2928 s), `-j20`; `firefox.exe` 779,264 bytes + `xul.dll` 180,012,544 bytes; `--version` = `Mozilla Firefox 153.6.0esr` |
| sixth build (patched) | not started; applies the Astra series + overlay next |

sccache for the fifth build: 2,082 requests, 1,985 executed, 36 hits (35
C/C++, 1 Rust), 1,954 misses, 0 cache write errors, 0 compilation failures;
cache 2 GiB / 10 GiB. This is the first pass over these sources, so misses
dominate; the same sources hit on the next build.

Warnings already known: `dxcompiler.dll` missing (WebGPU disabled), WASI
sandboxed libraries disabled in the baseline config. Both must be resolved
before a product build is claimed.
