# Native surfaces — rules, wiring contract and evidence log

> **Status:** active work contract for `feat/astra-native-surfaces`.
> **Owner direction:** every surface below must be real in the packaged dev
> build, natively wired to the engine, covered by tests, and verified against a
> real website (never only a purpose-built fixture).
>
> This file is the source of truth for this lane. If another note in this
> branch contradicts it, this file wins. Every status change is committed with
> the code that earns it.

## 1. Non-negotiable rules

1. **Native source of truth.** The running engine is the authority for tabs,
   split views, tab groups, page state, history and extension state. Astra's
   Svelte state is a projection. Never keep a second mutable copy of a native
   fact and never let a render succeed while its backend call failed.
2. **No second browser UI.** A Firefox menu, doorhanger, panel, window, tabbox,
   split-view footer, group header or context menu must not answer a person's
   action. Suppress or hide it and render the Astra surface. If the engine path
   cannot be replaced, stop and record a blocker — do not ship both UIs.
3. **Native split view, not a painted mock.** Side-by-side browsing uses
   `gBrowser.addTabSplitView` on the real `gBrowser` tabs. The shell's content
   stage stays `#tabbrowser-tabbox`; the Astra grid overlays controls only.
4. **Every visible control has a caller.** A row, toggle, drag target, shortcut
   or context-menu entry must reach a Host route, a Host module method and a
   real engine API. `unknown_command`, `no route`, an empty list or a disabled
   action is a defect when a backend exists.
5. **No invented wire shapes.** Extend `ui/packages/bridge/src/host-transport.ts`
   plus a contract test for every new command. Raw commands used by the app are
   declared in one place (`ui/app/src/shared/ipc/surfaces.ts`) and covered
   by `tests/contract/native_surfaces.mjs`.
6. **Contexts stay isolated.** Private windows record no history, peek state,
   split arrangements or space data. Two windows own separate models; every
   listener is keyed to its window and torn down with it.
7. **Everything opened is closed.** Every observer, listener, timer, canvas,
   `drawSnapshot`, thumbnail URL, worker and retained browser has an owner and
   a teardown. No per-navigation growth. Previews are bounded (one surface per
   window) and canvases are released after their data URL is read.
8. **Resource discipline.** Native split view replaces cloned browsers. Peek
   captures on demand and never keeps a live hidden `<browser>` per preview.
   Spatial-index lookups replace per-row scans where a list can grow. Reduced
   motion is honoured by every animation.
9. **Light and dark are one design.** Every surface uses semantic tokens; no
   hard-coded colour. Verify both themes and the `system` choice.
10. **Rust defines pure policy; Gecko glue applies it.** Split arrangement
    validation, the ratio band, peek bounds, history index keys and clone
    admission are implemented and unit-tested in
    `crates/astra-core/src/surfaces.rs`. Gecko-facing glue (XUL, `gBrowser`,
    Places, AddonManager) must be JS by platform constraint; that boundary is
    documented below, not hidden.
11. **Tests are the gate.** Contract + unit + component + a live Marionette
    probe against the packaged dev build. A surface is not done because it
    renders.
12. **Real websites only.** Live acceptance uses real pages (Wikipedia, MDN,
    GitHub, YouTube, The Verge) plus the existing blocker benchmark; synthetic
    HTML fixtures may be used for unit tests, never as the only proof.

## 2. Architecture

```
Astra UI (Svelte, chrome://astra)
        │  typed calls / raw surface commands
        ▼
Bridge route table  (ui/packages/bridge/src/host-transport.ts)
        │
        ▼
Host modules (overlay/astra/host/*.sys.mjs)
  SplitView · Peek · SpaceHistory · SpaceExtensions · Tabs/Content
        │                                   │
        ▼                                   ▼
Rust policy (crates/astra-core,              Gecko APIs
 astra-surfaces model)                       gBrowser.addTabSplitView
 - split arrangement validation              TabSplitView / TabGroup
 - peek session + TTL policy                 SessionStore
 - per-space history index                   Places (History/Bookmarks)
 - extension assignment policy               AddonManager / ExtensionPermissions
 - clone admission                           PageThumbs.drawSnapshot
                                             container userContextId
```

### Why the split between Rust and JS

Gecko is a C++/JS embedding host. Tabs, `gBrowser`, Places, AddonManager,
SessionStore and containers are only reachable from chrome-privileged JS (or
C++ patches). Re-implementing those in Rust would create a second browser
engine, which the owner explicitly forbids. Therefore:

- **Rust** defines and unit-tests the deterministic invariants: arrangement
  validation, ratio band, peek bounds, history index keys, clone admission and
  the private refusal (`crates/astra-core/src/surfaces.rs`). Gecko owns the
  live tabs/containers, so the chrome-side Host modules apply those invariants
  at the seam; the Rust tests are the reference, not a second runtime.
- **JS** owns the Gecko calls. Every JS module that touches Gecko is behind the
  Host API seam and has no fallback mock in the dev build.
- **C++** is touched only where the engine must stop drawing its own UI or must
  expose a missing hook; this lane currently needs none.

## 3. Surface inventory and acceptance

Legend: `todo` · `doing` · `done` (live-probed) · `blocked` (written reason).

### 3.1 Split view

| # | Surface | Required behaviour | Status |
|---|---|---|---|
| S1 | Side-by-side browsing | 2–3 real tabs share the content stage via one native split view; every boundary has its own resize handle; panes stay active when one is selected | done |
| S2 | Tab-based split | Tab menu and sidebar choose mode call `tabs_split`; never `unknown_command` | done |
| S3 | Drag-and-drop split | Dragging a tab onto the page's left/right edge opens it as a pane; drop inside reorders/leaves | done |
| S4 | Bookmark split | Bookmark row menu opens the bookmark beside the current page | done |
| S5 | Pinned tab split | Pinned tab menu opens its URL as a pane (native excludes pinned tabs from a split) | done |
| S6 | Link split | Page context menu has “Open Link in Split View” | done |
| S7 | Pane replacement | “Replace this pane” chooses another tab/bookmark and swaps it in place | done |
| S8 | Arrangement bookmarking | Save/restore a named split arrangement (tabs + order + ratio + space) | done |
| S9 | Group integration | Native tab groups are projected and rendered in Astra's sidebar; a split reads as a section whose head opens the split and whose rows open individual panes | done |
| S10 | Restoration | Arrangements restore after a real quit/relaunch, reconciled against live tab ids; no duplicate tabs | done |

### 3.2 Peek (floating preview)

| # | Surface | Required behaviour | Status |
|---|---|---|---|
| P1 | Floating preview | A window-like Astra popup shows a real page capture, with close, bookmark, open-tab and open-split controls; native preview UI never appears | done |
| P2 | Shift-click preview | Shift-click on a tab/bookmark opens the peek without switching | done |
| P3 | Context-menu preview | Tab/bookmark/link menus have “Preview” | done |
| P4 | Automatic bookmark preview | Hover a bookmark (delay setting) shows peek | done |
| P5 | Automatic pinned preview | Hover a pinned tab shows peek | done |
| P6 | Open as Tab | Peek card action opens/reuses the target tab | done |
| P7 | Open as Split View | Peek card action opens the target as a split pane | done |
| P8 | Independent peek per tab | Each peek binds to its own target tab/URL; two peeks never share state | done |
| P9 | Session restoration | Open peeks restore after relaunch (opt-in, private never) | done |
| P10 | Peek configuration | Category with delay, size, position, capture scale, auto-hover, restore, close-on-leave | done |
| P11 | Peek bookmark | The preview’s star adds the page to the active space’s bookmarks; closing frees the capture | done |

### 3.3 Space isolation

| # | Surface | Required behaviour | Status |
|---|---|---|---|
| I1 | Independent browsing history | History list and search are scoped to the active space; visits from another space are not shown, counted or suggested; no cross-space leakage | done |
| I2 | Profile-specific extensions | Each space has an extension set; switching spaces enables/disables add-ons for that space; settings show and edit the assignment | done |
| I3 | Cross-space tab cloning | “Clone to space” duplicates a tab (URL, title, history where the engine allows) into another space of the same profile, with that space's container | done |

## 4. Data and security invariants

- **Private windows** keep no peek history, no split arrangements, no history
  index entries and no extension assignment changes. Reads return empty and
  writes are refused (`private_context`). The refusal is a real answer, not a
  silent success.
- **Cross-space:** history/extension lookups always require a `space_id` that
  belongs to the active profile. A space id from another profile is rejected
  with `space_not_owned` without confirming whether it exists.
- **Previews:** the peek stores only `{ tabId, url, title, spaceId, capturedAt }`
  and a bounded data URL kept only while the card is mounted. No page DOM, no
  cookies, no form state, no full-page scrolling script injection.
- **Split:** a split view never spans containers. Cross-space “open in split”
  switches to the target space first or refuses; it does not mix partitions in
  one split view.
- **Extensions:** disabling an add-on for a space never uninstalls it; the
  profile-level install and its data stay. The UI states the profile-scope
  limitation.
- **Resource caps:** at most one peek surface per window, at most 4 native
  panes, at most 200 arrangement rows, at most 500 history index entries per
  space (oldest pruned), capture canvas released immediately.

## 4.1 Binding exception

`ui/app/src/shared/ipc/bindings.ts` is generated. This lane adds one optional
projection field, `TabView.group?: TabGroupView | null`, because the sidebar
must draw the engine's native group. It follows SCOPE rule 5's sanctioned
exception: the shape is recorded here, the host snapshot is covered by
`tests/contract/native_surfaces.mjs`, and a future generator input must carry
the same field. No other generated type was edited.

## 5. Settings taxonomy

Every new surface contributes rows to an existing category; nothing lives
outside a category.

| Category | Rows |
|---|---|
| **Tabs → Split view** | enable split view; maximum panes (2/3); restore arrangements on startup; remember per-window width; show pane titles; show pane close controls; open link target (same pane / new pane); drag-edge action; double-click divider to reset |
| **Tabs → Peeks** | enable peeks; trigger (hover/shift-click/context menu/both); hover delay (ms); card size; card position; capture scale; restore open peeks; close when pointer leaves; show URL; show title |
| **Privacy → History** | history scope (`this space` default / shared profile), per-space search; clear this space's history; show other spaces' history (off by default) |
| **Extensions → Per space** | enable per-space extension sets; default for new spaces; copy set from current space; show profile-scope limitation |
| **Tabs → Tab groups** | show native groups in sidebar; collapse remembered; colour source (native/Astra) |
| **Tabs → Clone** | clone target (ask/new space/last space); include history; open cloned tab in background |

All rows bind to `astra.settings.<key>` through the existing Settings host
module (native prefs where one owns the behaviour). Reduced motion and the
light/dark/ system theme apply to every new animation and surface.

## 6. Commands and routes

Existing generated commands that must become live:

- `tabs_split` → `SplitView.open`
- `tabs_unsplit` → `SplitView.unsplit`
- `tabs_leave_split` → `SplitView.leave`

Surface commands added by this lane (declared in
`ui/app/src/shared/ipc/surfaces.ts` and routed in `host-transport.ts`):

- `split_open_url`, `split_replace`, `split_focus`, `split_ratio`
- `split_bookmark_save`, `split_bookmark_list`, `split_bookmark_restore`,
  `split_bookmark_delete`
- `tab_group_create`, `tab_group_list`, `tab_group_collapse`, `tab_group_ungroup`
- `peek_open`, `peek_close`, `peek_capture`, `peek_list`, `peek_open_tab`,
  `peek_open_split`, `peek_configure`
- `space_history_list`, `space_history_clear`, `space_history_note`
- `space_extensions_list`, `space_extensions_assign`, `space_extensions_copy`
- `tabs_clone_to_space`

`tests/contract/native_surfaces.mjs` asserts: every declared command has a
route, every route has a Host method, every UI caller references a declared
command, and the route table never regresses to `unknown_command`.

## 7. Verification

Run from the worktree root:

```sh
# static
node tests/contract/native_surfaces.mjs
node tests/contract/wire_coverage.mjs
(cd ui && bun run --filter @astra/frame check)

# Rust policy
cargo test -p astra-core --jobs 2

# packaged build
(cd ui && bun run --filter @astra/shell-hello build && bun run --filter @astra/frame build:chrome)
(cd forge/astra-forge && cargo run -q -- overlay && cargo run -q -- build --faster)

# live (packaged dev build, real network pages)
python3 tools/marionette-probe/native-surfaces-probe.py out/native-surfaces
python3 tools/marionette-probe/adblock-benchmark-probe.py
```

The live probe must use real pages and record: split create/resize/replace/
restore, pane content URLs, peek capture of a real page, history isolation
between two spaces, per-space extension toggling, cross-space clone, plus
light/dark measurements. Screenshots for both themes are written to
`out/native-surfaces/`.

## 8. Evidence log

| Date | Change | Evidence |
|---|---|---|
| 2026-11-08 | Native split-view port (2–3 panes, per-boundary resize, active panes, replace/leave, drag-edge, arrangement restore, background-tab load) | `native-surfaces-probe.py` 44/44; a synthetic drag on the second divider changes pane 2/3 only; all three browsers stay active after selecting a pane; 4th pane refused |
| 2026-11-08 | Peek (real capture, window popup with bookmark/open-tab/open-split, hover/shift/menu, restore, settings) | same probe: 31 kB PNG capture, `.peek-window` above the page with an inset clip; closing empties `peek_list`; light/dark measured |
| 2026-11-08 | Per-space history, per-space extension sets, cross-space clone | same probe: scoped visits, extension read, clone into `space-1`; `native_surfaces.mjs` 118 checks |
| 2026-11-08 | Native tab groups projected and drawn | same probe: group created, 2 members projected, `.tab-group-head` drawn |
| 2026-11-08 | Full gates | typecheck, lint, stylelint, format, knip, 1238 unit tests, 95 settings controls, adblock benchmark PASS, `wire_coverage` PASS |

## 9. Honest limits (update only with a reason and an owner decision)

- Gecko chrome glue is JS by platform constraint. Rust owns policy, not the
  embedding.
- Firefox login/form stores remain disabled for cross-space safety
  (`mozilla.cfg`), per `PASSWORD_DECISION.md`.
- Places' on-disk history remains one database. Per-space history is enforced
  by an Astra visit index + scoped Host queries; the raw Places file is not
  partitioned per space. This is stated in Settings.
- WebExtensions are installed at profile scope. Per-space behaviour is an
  enable/disable assignment applied on space switch, not separate extension
  processes.
