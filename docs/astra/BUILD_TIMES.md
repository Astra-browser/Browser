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
