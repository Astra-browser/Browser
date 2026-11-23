# Patch churn, 153.6.0 ESR → 160.0.1 (D-58, 2026-11-23)

Static analysis, no build: for each patch's `+++ b/...` paths, the 153 baseline
blob (`git -C engine rev-parse HEAD:<path>`) is compared with the freshly
extracted 160.0.1 file (`git hash-object --no-filters`). Equal hashes mean the
patch's context is untouched upstream and it should apply cleanly; a differing
hash means the file churned and `forge import` will need 3-way or a rewrite.

This is a *prediction*. `out/patch-health.json` from a real `forge import` is the
authority; this table only says where to look first.

| Patch | Files | Changed | Identical | Note |
|---|---|---|---|---|
| ASTRA-0001 | 1 | 0 | 1 | `browser/app.mozbuild` unchanged |
| ASTRA-0002 | 1 | 1 | 0 | `browser.xhtml` churned |
| ASTRA-0003 | 3 | 3 | 0 | `Cargo.lock` + `toolkit/library/rust/shared/*` |
| ASTRA-0004 | 11 | 1 | 0 | only `toolkit/components/moz.build` is upstream; 10 files are the patch's own crate |
| ASTRA-0005 | 2 | 2 | 0 | `netwerk/url-classifier/*` |
| ASTRA-0006 | 1 | 1 | 0 | `dom/base/nsContentUtils.cpp` |
| ASTRA-0007 | 1 | 1 | 0 | `browser-fullScreenAndPointerLock.js` |
| ASTRA-0008 | 1 | 1 | 0 | `browser/actors/WebRTCParent.sys.mjs` |
| ASTRA-0009 | 1 | 0 | 1 | `LoginManagerAuthPrompter.sys.mjs` unchanged |
| ASTRA-0010 | 3 | 2 | 1 | `watcher.js` unchanged; the two `.sys.mjs` churned |
| ASTRA-0011 | 1 | 1 | 0 | `dom/webidl/Navigator.webidl` |
| ASTRA-0012 | 1 | 1 | 0 | `AsyncTabSwitcher.sys.mjs` |
| ASTRA-0013 | 4 | 4 | 0 | all four PiP surfaces churned |
| ASTRA-0014 | 13 | 6 | 2 | `Cargo.lock`, `Cargo.toml`, `StaticPrefList.yaml`, `dom/webauthn/moz.build`, bridge `Cargo.toml`, bridge `lib.rs`; the other 5 are the patch's own files |
| ASTRA-0015 | 2 | 0 | 2 | **both unchanged** — cross-drive objdir survives |
| ASTRA-0016 | 4 | 4 | 0 | NSPR clang-23 casts, all four |
| ASTRA-0017 | 1 | 1 | 0 | `mozglue/misc/PreXULSkeletonUI.cpp` |
| ASTRA-0018 | 1 | 1 | 0 | `browser.xhtml`, the second patch on it |
| ASTRA-0019 | 1 | 1 | 0 | `widget/windows/nsWindow.cpp` |
| ASTRA-0020 | 1 | 0 | 1 | **`PromptParent.sys.mjs` unchanged** — the P1 suppression survives |
| ASTRA-0021 | 3 | 3 | 0 | `nsWindowWatcher.cpp`, `AppWindow.cpp/.h` |

## What it means

- Four patches have no churn at all: `0001`, `0009`, `0015`, `0020`.
- `ASTRA-0020` is the one that mattered most: P1, and its file did not move, so
  prompt suppression is not a rewrite job on this base.
- `ASTRA-0015` carrying the cross-drive objdir means the D: build directory is
  not the thing that breaks first — which was the main risk in siting the
  objdir outside the tree.
- `browser.xhtml` is touched twice (`0002`, `0018`) and churned once; the two
  patches must be rebased in order and re-read against each other, not in
  isolation.
- `Cargo.lock` is touched by `0003` and `0014` and churned regardless, so the
  vendored-crate regeneration is unavoidable and is its own ticket (`#9`).
