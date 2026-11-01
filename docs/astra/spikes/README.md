# Spike briefs index (P0-T09) — one file per U-item before depending on it

Status: briefs drafted; spikes run in Phase 1 (or noted phase).

| ID | Question | Planned spike | Success criterion |
|---|---|---|---|
| U-01 | Sidecar stdio via Submodule on all 3 OSes | P1-T09 prototype | Sustained frames + kill/restart recovery; else loopback-WS fallback |
| U-02 | `mach build faster` for frontend-only rebuilds | P1-T04 measurement | Timed UI-only rebuild documented, or keep full incremental |
| U-03 | Artifact builds on pinned ESR from shallow git | P1-T04 trial | Or documented skip |
| U-04 | Svelte output under chrome CSP via `chrome://astra/` | P1-T08 loader test | Else custom Vite pre-compile |
| U-05 | `<browser>` placement by CSS (single + multi) | S-01 (P3-T02) | Prototype demo |
| U-06 | History mirror into Places for `:visited` | P2-T07 test | Visited styling works post-navigation |
| U-07 | Containers modelling spaces/profiles | S-02 (P3-T07) | Isolation test passes |
| U-08 | Linux global hotkey (X11 crate / Wayland portal) | P8-T05 matrix | Desktop support table |
| U-09 | Windows updater without Mozilla-signed service | P9-T06 trial | Per-user in-place update path |
| U-10 | `archive.mozilla.org` tarball URL layout for ESR 153 | P1-T01 verification | Checksum + signature verified |
| U-11 | Out-of-tree dir wired via `moz.build`/`jar.mn` hooks | P1-T05 trial | ASTRA-0001 patch |
| U-12 | Core separable from Tauri/Wry at adapter seam | P0-T04 (`BrowserHost` draft) | Trait compiles against ported crates |
| U-13 | Win Mica / macOS vibrancy via widget work | P9-T07, P10-T06 | Owner-approved P3 patches or fallback themes |
