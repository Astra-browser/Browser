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
| P0 | `merge/p0-baseline` | Run all gates on `main`, record baseline, tag `pre-native-merge-20261104`, create the worktree/branch convention | — | **done** |
| P1 | `merge/p1-boot` | Merge `Boot` + `BootSidecar` into one supervisor; lazy native `Subprocess`; package it; keep the Node-pure import path | P0 | **merged** |
| P2 | `merge/p2-native-nav` | Make `nav.stop`, page zoom and `Navigation.print` call the live browser; prune dead/duplicate command ids; hard-reload distinction | P0 | **merged** |
| P3 | `merge/p3-windows` | Bind `Windows` to `BrowserWindowTracker`/`OpenBrowserWindow`; real focus/close/fullscreen; thin projection keyed by native ids | P0 | **merged** |
| P4 | `merge/p4-gbrowser` | **Complete.** Native `gBrowser` tabs, model projection, mute/pin/discard/space/adoption, native-only shell; legacy standalone mount deleted. | P1–P3 | **merged** |
| P5 | `merge/p5-session` | Firefox `SessionStore` is live; restored native tabs are adopted. Astra spaces/pins persist in the Rust store; the JS `Session` shadow model is retired. | P4 | **P5a+P5b merged; folders + sync open** |
| P6 | `merge/p6-dialogs` | Native permission/auth/cert/download decisions with Astra UI on top; no content resolution | P1 | **P6a merged (store); P6b-1 merged (geolocation prompt); camera/mic prompt seam open** |
| P7 | `merge/p7-containers` | Native `ContextualIdentityService` per space; delete clears data; move re-isolates; private never persists | P4 | **merged** |
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

**Spike design (architect review, 2026-11-04):**

- ESR 153 has **no `#appcontent`**. The content deck is
  `#browser > #tabbrowser-tabbox > #tabbrowser-tabpanels`; `gBrowser` already
  owns real browsers today, they are only `display:none`. No reparenting and no
  new engine patch: ASTRA-0002 already puts `#astra-root` immediately before
  `#browser`.
- Dock the native panel behind the Astra stage: keep the native tab strip
  (`#navigator-toolbox`) hidden, make `#browser` absolute/transparent, position
  `#tabbrowser-tabbox` with explicit px vars from the Astra content slot
  (`--astra-stage-x/y/w/h`), and gate visibility on
  `data-app-booted="true"` + `data-astra-stage="page"`. Use explicit px, not
  `inset` (D-30).
- New pref `astra.gbrowser.enabled` (default false) for a one-line rollback
  through commits 1–3.
- Keep `astra_tab_id` allocation in `Tabs.sys.mjs`; `Content.mount` maps
  `astra_tab_id ↔ native tab` and adopts engine-created tabs (`window.open`,
  target=_blank, ctrl-click, restore) so the sidebar never diverges.
- Truth flows native → model via `TabOpen/Close/Move/Select/Pinned/AttrModified`
  plus the existing progress listener. Projection/event shapes stay unchanged.
- Moves to gBrowser: browser creation/panel mounting, selection/activeness,
  close/reload/duplicate/move/pin, `discardBrowser`/`TabUnloader`, mute
  (`muteAudio`), crash, back/forward truth.
- Stays in Content/Astra: id map + event translation, URL scheme gate,
  space→`userContextId`, private rules, favicons, hiding/blocker, stage rect,
  fullscreen.
- **SessionStore is a P4 hazard, not a P4 feature.** Native tabs start writing
  and restoring sessions; P4 pins `browser.startup.page=0` and
  `browser.sessionstore.resume_from_crash=false` and asserts no
  `sessionstore-backups` writes. P5 owns the real store.
- **Split view conflict:** native `#tabbrowser-tabpanels[splitview]` and
  `gBrowser.addTabSplitView` compete with Astra's split; P4 keeps one pane and
  asserts the attribute is never set.
- **Risks/gates:** first-paint regression (boot-frame assertion), hidden
  tab-strip geometry (`gbrowser_stage.py` rect ±1 px), private windows
  (`userContextId=0`, no history), cross-space move (remove + recreate in the
  target container), session hazard (no backup writes).

**Spike commits:**

1. `feat(shell): dock the native tabbrowser panel behind the Astra stage` —
   CSS overlay + `stage-rect.js` + state machine + `Content.mountNative`
   behind `astra.gbrowser.enabled`; old mount kept. Gates:
   `shell_app_chrome.py`, new `gbrowser_stage.py`, screenshots.
2. `feat(host): bind astra_tab_id to native gBrowser tabs` — map, adoption,
   native events, progress listener, `Tabs.create/select/close/move` delegate.
3. `feat(host): drive mute, discard and pin through gBrowser` —
   `muteAudio`, `discardBrowser`, `TabUnloader`, `reloadTab`, `duplicateTab`,
   `pinTab`; live PSS/process and audio probes.
4. `refactor(host): delete the standalone content-browser path` — remove
   `createBrowser`/`park`/warm seeding and the old mount; drop the pref; update
   `HOST_API_v1.md` and `STATE.md`. Point of no return; merge separately.

**Tests:** live tab lifecycle, mute audio, discard PSS/process drop, unload,
restore, UI parity screenshots, `containers_isolation`, `session_restore`.

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
| Session | `cargo test -p astra-core` (Rust `SessionSnapshot`) + `node tests/contract/metadata_restore.mjs` |
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
| 2026-11-04 | P0 | done: `hostapi_v1` 306, `commands_model` 50, `session_restore` 99, `tab_lifecycle` 4, bridge 26; state/brand clean; tag `pre-native-merge-20261104` |
| 2026-11-04 | P1 | done: `boot_model` 31, `sidecar_spike` PASS; Boot is the single core supervisor (single-flight launch, bounded handshake, timeout shutdown, dead-core detection); shell calls `launchCore` on mount and `shutdown` on quit; pref `astra.core.command` defaults empty |
| 2026-11-04 | P2 | done: `native_nav_model` 17; live probe stop `about:blank` after a 4 s slow page, model loading cleared, zoom readback `1.5`, soft reload no-cache=false vs hard reload no-cache=true; overlay + `build --faster` used |
| 2026-11-04 | P1/P2 review | code review found the supervisor unreachable + failure-path bugs; fixed and re-reviewed PASS-WITH-NOTES. Remaining notes are P4/P5 work, not blockers. |
| 2026-11-04 | P1/P2 merge | merged to `main` as `df24279` + `7edb116`; tag `post-p1-p2-20261104`. P3/P4 next. |
| 2026-11-04 | P5b-2d | merged as `5c776305`; tag `post-p5b-focus-20261104`. only the focused window writes; each window owns its model, so an unfocused save would replace the focused organisation. Private still refuses; unknown focus is permissive. |
| 2026-11-04 | P5b-2c | merged as `a1fa2e20`; tag `post-p5b-lazy-20261104`. lazy SessionStore tabs retry the restore on `nav.committed` for 60s/40 attempts; the saved active space moves only on the first attempt. |
| 2026-11-04 | P5b-2b | merged as `335cb2d5`; tag `post-p5b-package-20261104`. `forge build` compiles and installs `astra-core` in `dist/bin`; the shell auto-detects it beside the browser binary, so the packaged build runs the store with no pref. Autodetect probe PASS. |
| 2026-11-04 | P5b-2 | merged as `21ab3c95`; tag `post-p5b-host-20261104`. host wiring: shell launches the sidecar with `--db <profile>/astra/core.sqlite`; `Metadata` captures spaces + per-URL space/pin, restores before/after the native mount, and flushes the last accepted snapshot on quit. Private tabs and windows never enter the store, non-http(s) URLs are dropped, and an empty capture never overwrites. Live probe: Work space + pinned tab survive a clean quit/relaunch; a private window refuses to save; the DB has no private URL. Multi-window merge and folders are P5b-3. |\n| 2026-11-04 | P5b-1 | merged as `2aade81b`; tag `post-p5b-sidecar-20261104`. `astra-core` now builds a real sidecar binary (`--db`, Appendix C frames) that validates and persists `SessionSnapshot` in `astra-store`. Eight black-box tests spawn it: cross-process durability, named snapshots, invalid/future payloads refused without clobbering the last good row, version gate, unknown command, EOF exit. Host capture/apply is P5b-2; nothing is wired into the shell yet. |
| 2026-11-04 | P6b-1 | merged as `2d76c8f2`; tag `post-p6b-prompt-20261104`. `Permissions` publishes `page-permission-prompt-changed`, the app prompt answers via `page_permission_respond`, and a bounded `Operations` ledger settles the disposition. Live probe: real geolocation request renders the Astra prompt, a real click writes ALLOW, deny writes DENY, and the page observes granted/denied. Camera/microphone still use Firefox's WebRTC prompt. Probe: 23 checks (allow, deny, navigate-away, tab-close, sharing state). |
| 2026-11-04 | P6a | `Dialogs.decidePermission` writes `Services.perms` (grant/deny, EXPIRE_NEVER); live probe checks ALLOW/DENY. Runtime prompt UI is P6b. |
| 2026-11-04 | P7b | merged as `de7e8b1`; tag `post-p7b-20261104`. private windows stay context 0; cross-space moves recreate in the target identity (space-2 ↔ space-1). Live probe `containers_private_move_probe.py` PASS. |
| 2026-11-04 | P7a | merged as `a3e457f`; tag `post-p7-containers-20261104`. space→identity map; native tabs get the identity userContextId; deleting a space removes the identity/data. Live probe `containers_space_probe.py` PASS. Private isolation/P7b next. |
| 2026-11-04 | P5a | merged as `b3b70b7`; tag `post-p5-session-20261104`. SessionStore restores both tabs with native ids; blank bootstrap row removed. P5b is Astra metadata in Rust. |
| 2026-11-04 | P4.4b-2 | merged as `a3244d7`; tag `post-p4-complete-20261104`. deleted `Content.mount` and its standalone-only unit tests; product and tests now use native tabs. `host-model` 14, `shell_app_chrome`, `gbrowser_tabs` PASS. |
| 2026-11-04 | P4.4b-1 | merged as `39c8f9f`; tag `post-p4-native-only-20261104`. shell is native-only: pref/fallback removed; legacy `Content.mount` retained only for tests. `shell_app_chrome`, `gbrowser_tabs`, `sessionstore` PASS. |
| 2026-11-04 | P4.4a | merged as `269864f`; tag `post-p4-default-20261104`. native is default (`astra.gbrowser.enabled=true`); multi-window mounts one native tab per window; `gbrowser_multiwindow_probe` PASS. Standalone mount remains as pref-off fallback; deletion is P4.4b. |
| 2026-11-04 | P4.3 | merged as `558eca8`; tag `post-p4-p43-20261104`. Pin/unpin, discard/wake, cross-space recreate, engine-tab adoption; `gbrowser_p43_probe.py` PASS. P4.4 deletes the standalone path. |
| 2026-11-04 | P4.2 | merged as `367ca01`; tag `post-p4-tabs-20261104`. native `mountNative`: window-scoped model ↔ `gBrowser` map, initial-tab adoption, native→model select/close, busy clear, top-level-only commits, background-load on activation, container-aware adoption, mute. Live: stage page, model/native select+close both directions, create/close, `audioMuted` ✓. Pin/discard/session/adoption are P4.3/P5. P4.2 is single-window: `mountNative` refuses a second window until the P5 global id map. |
| 2026-11-04 | P4.1 | stage dock behind `astra.gbrowser.enabled`; panel rect == slot (256,8,1016,884), hidden until mounted, native strip hidden; `stage_rect` 9 + `shell_app_chrome` PASS. |
| 2026-11-04 | P3 | merged as `5867be3`; tag `post-p3-windows-20261104`. Windows API opens/focuses/closes real windows; own-window binding; native fullscreen; private detection; live probe 1→2→1 windows, native focus, fullscreen on/off, private create/close. Re-review PASS-WITH-NOTES; remaining notes are P5 session work. |
| 2026-11-04 | P4 design | architect review done: mount is `#tabbrowser-tabbox`, no reparenting, pref-gated; SessionStore is a hazard to contain in P4 and lands in P5 |
