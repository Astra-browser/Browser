# Native binding merge — execution plan

> **Status:** active, started 2026-11-04. Owner direction is recorded in
> `docs/astra/NATIVE_BINDING.md`; this file is the execution plan and status
> log. **UI parity is a hard gate:** no Firefox-looking chrome, no visual
> change, and no Astra-only feature may be removed.

## Guardrails

1. **Keep the Astra UI.** The native engine is the backend; the Astra shell,
   app, tabs, spaces, sidebar, panels and dialogs stay the visible UI. A phase
   that changes pixels must include before/after screenshots.
2. **Keep Astra-only features.** Notes, tasks, Work, AI, accounts, profiles,
   local-first sync and the custom keymap are not replaced by Firefox features.
3. **One source of truth.** Remove a JS shadow model only when the native owner
   is wired and verified. Never leave two writers.
4. **No fake controls.** A visible action must be native, explicitly app-level,
   or removed. `unknown_command` and silent flag flips are defects.
5. **Branch per phase.** `merge/pN-<name>`, merge with `--no-ff`, tag the
   pre-merge tree, never edit `main` directly. One logical commit per change.
6. **Test every phase.** Unit/contract + live Marionette + screenshot where
   visible. Engine builds always use `--jobs 2`.
7. **Rust first.** JS only for chrome glue; C++ only for a measured hot-path
   win (see `NATIVE_BINDING.md` §2).

## Phase plan

| Phase | Branch | Scope | Depends on | Status |
|---|---|---|---|---|
| P0 | `merge/p0-baseline` | Run all gates on `main`, record baseline, tag `pre-native-merge-20261104`, create the worktree/branch convention | — | **doing** |
| P1 | `merge/p1-boot` | Merge `Boot` + `BootSidecar` into one supervisor; lazy native `Subprocess`; package it; keep the Node-pure import path | P0 | planned |
| P2 | `merge/p2-native-nav` | Make `nav.stop`, page zoom and `Navigation.print` call the live browser; prune dead/duplicate command ids; hard-reload distinction | P0 | planned |
| P3 | `merge/p3-windows` | Bind `Windows` to `BrowserWindowTracker`/`OpenBrowserWindow`; real focus/close/fullscreen; thin projection keyed by native ids | P0 | planned |
| P4 | `merge/p4-gbrowser` | **Critical path.** Spike native `gBrowser` tabs with the native strip hidden; move page lifecycle to `gBrowser`; keep `astra_tab_id` as a projection key; wire mute, discard, unload, move-between-spaces | P1–P3 | planned |
| P5 | `merge/p5-session` | Replace the JS `Session` model with Firefox `SessionStore` + Astra metadata (space/folder/pin/sync) in the Rust store | P4 | planned |
| P6 | `merge/p6-dialogs` | Native permission/auth/cert/download decisions with Astra UI on top; no content resolution | P1 | planned |
| P7 | `merge/p7-containers` | Native `ContextualIdentityService` per space; delete clears data; move re-isolates; private never persists | P4 | planned |
| P8 | `merge/p8-resources` | Split `Resources`: tasks/notes/media → Rust; page source → native browser; delete the in-memory task store; retire `Panes` | P1 | planned |
| P9 | `merge/p9-media-ext` | Bind `Media` to the native media controller and `WebExtensions` to `AddonManager`, or remove both surfaces | P4 | decision |
| P10 | `merge/p10-cleanup` | Remove dead routes/models, shrink `HostAPI`, update docs and the audit, final regression pass | all | planned |

### Dependency graph

```
P0 -> P1 -> P2
        \-> P3 -> P4 -> P5
                    \-> P7
        \-> P6
        \-> P8
P4 -> P9 -> P10
```

P4 is the critical path. SessionStore, discard, unload, mute and move-between-
space isolation cannot be correct until tabs are native `gBrowser` tabs.

## Phase details

### P0 — baseline

- Run the current gates and record results in the status log.
- Tag `pre-native-merge-20261104` for rollback.
- Confirm the dev build launches and the UI screenshot baseline exists.
- No code change beyond this file.

### P1 — boot

- Move `SidecarFrame` and `BootSidecar` into `Boot.sys.mjs`.
- Keep `Boot` importable in Node: resolve `Subprocess` lazily inside
  `launchCore`, never at module scope.
- `Boot.launchCore({ command })` answers `unavailable` when no core path is
  configured; it never invents a process.
- Keep `BootSidecar.sys.mjs` as a re-export shim for tests/compat, or delete it
  after updating callers.
- Package `Boot.sys.mjs` (already in `jar.mn`); do not package the shim.
- Tests: Node import, unavailable path, existing `hostapi_v1.mjs`, sidecar
  spike unchanged.

### P2 — native navigation

- `Content.mjs` listens for `nav.stopped`, `nav.zoom-changed` and
  `nav.print-requested` and calls `browser.stop()`, `ZoomManager` and
  `PrintUtils` on the right browser.
- `hardReload` uses `LOAD_FLAGS_BYPASS_CACHE`; `reload` stays soft.
- Prune command ids that have no native or app-level owner; keep one registry.
- Tests: live slow-page stop, live zoom readback, print dispatch, command model.

### P3 — windows

- Replace the window map with native `BrowserWindowTracker`/ `OpenBrowserWindow`
  bindings; keep `window_id` as the native window id projection.
- Focus, close, fullscreen and title go through `window`/`WindowMediator`.
- Tests: live new/private/close/focus/fullscreen; contract for the projection.

### P4 — native tabs

- Spike first: create a `gBrowser` tab, hide the native tab strip, and mount the
  native content area in the Astra stage without reparenting.
- Then move `Tabs.create/select/close/duplicate/move` to `gBrowser`.
- `astra_tab_id` maps to the native tab; the Astra projection stays.
- Wire `browser.muted`, `gBrowser.discardBrowser`, `TabUnloader`, SessionStore.
- Moving a tab across spaces must reload in the target container.
- Tests: live tab lifecycle, mute audio, discard PSS/process drop, unload,
  restore, UI parity screenshots.

### P5 — session

- Use `SessionStore` for history/scroll/form/tab restore.
- Keep only space/folder/pin/sync metadata in Rust.
- Retire `Session.sys.mjs`'s parallel snapshot after migration.

### P6 — dialogs

- Native observers for permissions, auth, cert, downloads and context menus.
- Astra prompt UI on top; chrome-only resolution; permissions stored in
  `Services.perms`.
- Tests: permission allow/deny, auth, certificate one-load, download gate.

### P7 — containers

- `ContextualIdentityService` identities per space.
- Delete space → remove identity + clear data; move tab → reload in target.
- Tests: cookie/localStorage isolation per space, delete wipes, move re-isolates.

### P8 — resources and panes

- Split `Resources`: Rust store for tasks/notes/media; native page source.
- Delete the in-memory task store.
- Retire `Panes` unless real per-slot browsers are designed.
- Tests: task persistence across restart, page source, no `resource_call`
  god-module.

### P9 — media and extensions

- Bind `Media` to `browser.mediaController` and `WebExtensions` to
  `AddonManager`, or remove the surfaces. Decide before coding.

### P10 — cleanup

- Remove dead commands/routes/models, shrink `HostAPI`, update docs, run the
  full regression and the final audit.

## Test matrix

| Layer | Command |
|---|---|
| Host contract | `node tests/contract/hostapi_v1.mjs` |
| Commands | `node tests/contract/commands_model.mjs` |
| Session | `node tests/contract/session_restore.mjs` |
| Tab lifecycle | `node tests/contract/tab_lifecycle.mjs` + `python3 tests/contract/tab_lifecycle.py` |
| Live shell/UI | `python3 tests/contract/shell_app_chrome.py` |
| Bridge | `(cd ui/packages/bridge && bun test)` |
| UI | `(cd ui/app && bun run vitest run)` / `bun run check` |
| Lint/state | `python3 tools/state-check.py && bash tools/brand-lint.sh` |
| Forge | `(cd forge/astra-forge && cargo run -q -- lint && cargo run -q -- footprint)` |
| Build | `(cd forge/astra-forge && cargo run -q -- overlay && cargo run -q -- build --faster)` |
| Engine build | `(cd forge/astra-forge && cargo run -q -- build --jobs 2)` — only if engine files change |

## Subagent use

- **architect**: review this plan and the phase dependencies before P4.
- **tdd-guide**: write the failing tests for a phase before implementation.
- **code-reviewer**: review each phase branch before merge.
- **explore**: map call sites for a phase when the file set is not obvious.

Parallel agents are allowed only for disjoint file sets; otherwise run
sequentially. `git worktree` is used for parallel phases; the main session keeps
`main` clean.

## Rollback

- Tag `pre-native-merge-20261104` before P1.
- Each phase is a branch merged with `--no-ff`; a failed phase is reverted with
  a merge revert, not by rewriting `main`.
- The UI baseline screenshot set is the visual rollback reference.

## Status log

| Date | Phase | Result |
|---|---|---|
| 2026-11-04 | P0 | started; baseline gates running |
