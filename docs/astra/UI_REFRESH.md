# Interface refresh — paper chrome

> Status: active lane, 2026-11-05. Scope remains `docs/astra/SCOPE.md` (D-38).
> This document records the visual contract, the frozen surfaces and the
> verification for the refresh. It does not add product surfaces.

## 1. What changes

The window adopts the reference's **paper** reading: a warm light field, a
floating content card, a quiet sidebar and one main-page bar. Dark keeps
Astra's existing colour scheme unchanged; only the light tokens change.

| Surface | Contract |
|---|---|
| Window ground | 8px gutter; warm wallpaper behind chrome and card |
| Main-page bar | 40px, content column only; nav + the existing search field |
| Sidebar | 240px expanded; utilities in its top row; tab list below the header |
| Tab row | 28px high, 8px radius, 8px inset, 2px gap, 16px favicon, 13px/500 |
| Active row | warm-white pill (`#fffdf9`); hover is 5% ink |
| Content card | 12px radius, one soft drop, no drawn outline |
| Utility bar | The column's top row; beside a tool or Settings, the panel's head row |
| Menus | 12px radius, 6px padding, 30–34px rows, 13px label, 11px hint |
| Motion | 120ms fast, 200ms base, 300ms slow, 400ms page |

Tokens: `--main-bar-height`, `--row-tab`, `--radius-tab`,
`--tab-inset`, `--tab-gap`, `--window-gutter`, `--shell-ground`.

## 2. Frozen surfaces — do not restyle

The search bar is the product's existing search bar. It is **reused**, never
redesigned:

- `ui/app/src/features/address/components/AddressField.svelte`
- `ui/app/src/features/search/components/NewTabSearch.svelte`
- `ui/app/src/features/sidebar/components/SidebarSearch.svelte`
- their component tests

A wrapper may set width and position. It may not change height, radius,
typography, colours, suggestions, the site tray, focus behaviour or the
submitted result. While the column is in its full shape the same field is
drawn at the column's head (see §6), composed once by the shell; the bar keeps
it where the column is a rail, a panel, or put away.

## 3. Lanes

| Lane | Branch | Owns |
|---|---|---|
| Foundation | `agent/ui-refresh-foundation` | tokens, window ground, this doc |
| List | `agent/ui-refresh-list` | sidebar column, tab rows, space row, list sections |
| Rail | `agent/ui-refresh-rail` | utility rail, sidebar width composition |
| Toolbar | `agent/ui-refresh-toolbar` | main-page bar, card top, shell inset |
| Menus | `agent/ui-refresh-menus` | menus, popovers, dialogs |
| Pages | `agent/ui-refresh-pages` | New Tab, Notes, Extensions, Settings, Library |

Merge order: foundation → list → menus → pages → rail → toolbar.

## 4. Wiring rules

- Every control keeps its existing caller. Restyling never removes an action.
- The toolbar moves the existing address field; it does not fork it.
- The utility bar opens the existing tool panels (`$session/tools`), not new routes.
- No new wire types, commands or events.
- Private windows keep no utility history and no second model.
- Every listener, observer and timer added by a lane has a teardown.

## 5. Verification

Per lane:

```sh
cd ui/app && bun run typecheck
cd ui/app && bun run stylelint
cd ui/app && bun run test:component
cd ui/app && bun run build:chrome
```

After merge:

```sh
python3 tests/contract/shell_app_chrome.py
node tests/contract/hostapi_v1.mjs
node tests/contract/shell_assembly.mjs
node tests/contract/frame_model.mjs
python3 tools/state-check.py && bash tools/brand-lint.sh
(cd forge/astra-forge && cargo run -q -- lint && cargo run -q -- footprint)
```

Live: `./tools/run-dev.sh` then `tools/marionette-probe/ui-consistency-probe.py`
at wide, narrow and private sizes. The probe must show the unchanged search
field, the tab list, the rail and the native page starting at the stage's own
top edge when the column is in its full shape (see §6).

## 6. Column head (UI v2, D-52)

The column's head carries the page's controls and the one address field:

```
| back  forward  reload  home   ...   put-away |   nav row
| the address field                        shield |   field row
| media downloads notes spaces sleeping ext theme |   utility row
```

- `features/toolbar/components/PageNav.svelte` is the one navigation group;
  the bar and the column head both mount it, so disabled states and the
  history menus cannot drift.
- `Shell.svelte` composes the field once and hands it to whichever place
  draws it. The bar is not rendered at all while the column is in its full
  shape, so there is one field, never two.
- The bar returns when the column is a rail (Work, Tasks, Notes, a tool
  panel), when it is put away (the floating bar over a page), and when
  `ui.main-bar` is pinned to `always`.
- The host still insets a native page by the bar's row only when the bar is in
  the row; with the column's own head the page starts at the stage's 8px edge,
  which the shell already does for the floating bar (`data-astra-bar`).

## 7. Out of scope

- Boost and Easel: no Astra backend exists; do not fake them.
- Account, sync, billing and update services.
- macOS and Windows ports.
- New product surfaces with no UI caller.
