# Astra window frame (P3-T03, Linux first)

> Status: frame sources + contracts landed (worker-frame,
> `agent/P3-T03-frame`). Shell wiring (jar.mn registration + Shell
> integration) is orchestrator integration work — see §7.

## 1. What shipped

| Path | Owns |
|---|---|
| `overlay/astra/chrome/frame/frame.css` | Frame layout + drag regions + window-control styling (chrome-registered copy; ships in the build once wired per §7) |
| `overlay/astra/chrome/frame/Frame.sys.mjs` | Chrome binding: `reportDragRegions(doc, win)` (getComputedStyle-backed), `dispatchWindowControl(host, chrome, opts)` (Host API close/fullscreen, chrome adapter for minimize/maximize/restore), `csdMode()` |
| `ui/shell/src/frame/frame.js` | Imperative DOM builders (chrome-XUL-safe, P1-T10 pattern): `createTitlebar` / `createSidebar` / `createToolbar` |
| `ui/shell/src/frame/frame.css` | Svelte-side mirror of the chrome stylesheet (standalone preview) |
| `ui/shell/src/frame/Titlebar.svelte` `Sidebar.svelte` `Toolbar.svelte` | Thin wrappers mounting the builders via `onMount` |
| `tests/contract/frame_model.mjs` | 27 stub checks (dispatch routing, drag reporting with fakes, builders) |
| `tests/contract/frame_live.py` | 17 live checks in the built binary (sheet applies, reporting runs, dispatch via live v1 Windows module, fullscreen hiding, P1-T08 intact) |

## 2. Drag regions — how it works and what the engine allows

Firefox drags windows from any element with `-moz-window-dragging: drag`
that is not covered by a `no-drag` descendant. Verified against pinned
ESR 153 (read-only):

- Property definition: `layout/style/GenerateCSSProperties.py` lists
  `-moz-window-dragging` under "chrome-only internal properties ...
  **parsed by UA sheets only**". Client/author sheets, inline styles and
  CSSOM `setProperty` silently drop it (probed live: `CSS.supports` false,
  inline declaration reads back `""`).
- Same file Firefox itself uses: `toolkit/themes/linux/global/global.css`
  (`xul|toolbar[type="menubar"] { -moz-window-dragging: drag; }`).
- CSD gating: `browser/base/content/browser-customtitlebar.js` enables the
  `customtitlebar` attribute only when
  `window.matchMedia("(-moz-gtk-csd-available)").matches` (GTK). Our
  `csdMode()` mirrors that gate so the shell can fall back to an SSD row.

### Measured CSSOM limitation (do not "fix" — engine behavior)

`getComputedStyle(el).getPropertyValue("-moz-window-dragging")` returns
`""` even in the chrome window, even with the declaration demonstrably
applied (background/display from the same rule compute correctly) and
even for XUL elements. Cross-checked against upstream
`layout/style/test/test_non_content_accessible_properties.html`, which
asserts these properties are invisible to CSSOM. Consequences:

- `reportDragRegions()` still reads via `getComputedStyle` (correct
  wherever the engine exposes the property, e.g. future ESRs or other
  toolkits), but on ESR-153/Linux the test asserts *application
  structurally*: the agent sheet registers, the rules match the live
  elements (co-located `display`/`background`/`cursor` compute), and the
  declaration text is asserted in the shipped stylesheet.
- Functional dragging (pointer-grab moves the window) cannot be asserted
  headless — no window manager moves windows there. GUI verification on
  real X11/Wayland compositors is required before GA (checklist §6).

## 3. Window controls

`dispatchWindowControl(host, chrome, { action, window_id, request_id })`:

- `close` → `host.Windows.close` (model refuses the last window:
  `last_window`; multi-window close cascades to tabs).
- `toggle-fullscreen` → `host.Windows.get` + `setFullscreen(!current)`
  (emits `window.fullscreen-changed`; the shell mirrors it to
  `window.fullScreen` and the `data-astra-fullscreen` frame attribute).
- `minimize` / `maximize` / `restore` → `chrome` adapter
  (`{ minimize(), maximize(), restore() }`) wired to the DOM window in
  the shell; without an adapter returns `unsupported_chrome_op` (never
  silently no-ops). Unknown actions → `invalid_window_action`.

The P1-T10 `win.__astraHost` seam exposes only
`{ Tabs, Navigation, Panes, addEventListener }`; window-control wiring in
the shell will call `dispatchWindowControl` with the full Host API (§7).

## 4. Layout

```
.astra-frame (column, fills #astra-root)
├─ .astra-titlebar  (drag strip + title + window controls)
├─ .astra-toolbar   (frame-level actions; URL bar mounts below in .astra-main)
└─ .astra-frame-body (row)
   ├─ .astra-sidebar (200px, collapsible to 48px rail)
   └─ .astra-main    (content slot + URL bar live here today)
```

Fullscreen (`data-astra-fullscreen="true"`, driven by the
`window.fullscreen-changed` event) hides titlebar/sidebar/toolbar so
content gets the whole window — asserted live (`display: none` × 3).

## 5. X11 / Wayland WM edge cases

| # | Case | Behavior |
|---|---|---|
| E-01 | GNOME/Mutter Wayland, CSD available | Custom titlebar draws, drag strip works, `min/max/close` are ours. CSD button order follows `env(-moz-gtk-csd-*-button-position)`; our controls sit trailing — acceptable until P3-T08 theming aligns order with the WM. |
| E-02 | KDE/KWin Wayland, SSD enforced | `(-moz-gtk-csd-available)` false → frame renders as a plain toolbar row; the WM titlebar owns dragging. No double-drag conflict (our `drag` is inert without CSD). |
| E-03 | X11 (XWayland or native), CSD on | Drag works via `_NET_WM_MOVERESIZE` initiated by widget code; no app-side protocol. |
| E-04 | X11, no CSD / tiling WMs (i3, Sway, Hyprland) | Native decorations absent by design; floating drag is meaningless; keyboard controls (Alt+drag, shortcuts) remain WM-owned. Frame must never assume pointer-draggable — window controls + shortcuts are the contract. |
| E-05 | `drawInTitlebar` false / `browser.tabs.inTitlebar` off | Firefox will not set `customtitlebar`; `csdMode(false)` → `"ssd"`; shell keeps the frame as a static row. |
| E-06 | Fullscreen / kiosk | Chrome rows hidden (§4); Esc handling stays with Gecko (`window.fullScreen` round-trip). |
| E-07 | HiDPI / fractional scaling | Frame uses `rem`/flex, no pixel math; drag-region rects are CSS px. No action. |
| E-08 | Server-side close button vs ours | With CSD the app must provide close (we do). With SSD the WM provides its own; ours remain as duplicates in the row — P3-T08 theming may hide ours when `csdMode()==="ssd"`. |

## 6. Pre-GA GUI checklist (real compositors, not headless)

- [ ] GNOME Wayland: drag titlebar moves window; min/max/close work; focus ring visible.
- [ ] KDE Wayland + X11 KWin: SSD fallback row, no dead drag area.
- [ ] Sway/Hyprland tiling: frame usable without pointer drag.
- [ ] Fullscreen video + F11: chrome hides/shows correctly.
- [ ] Window menu (Alt+Space) still reachable via WM.

## 7. Integration (orchestrator)

Not applied by this lane (files outside `chrome/frame/`, `ui/shell/src/frame/`,
`tests/contract/frame_*`, `docs/astra/FRAME.md` are locked to other lanes):

1. `overlay/astra/jar.mn`: register the frame resources —
   `content/astra/res/frame/frame.css (chrome/frame/frame.css)`,
   `content/astra/res/frame/Frame.sys.mjs (chrome/frame/Frame.sys.mjs)` —
   plus a `skin astra ...` / `style chrome://browser/content/browser.xhtml`
   line (or `nsIStyleSheetService` AGENT_SHEET registration at shell
   startup, as the live test does) so `-moz-window-dragging` parses.
2. Rebuild the Svelte shell with the frame components mounted in
   `Shell.svelte`; extend `win.__astraHost` with `Windows` (+ `Frame`)
   and wire titlebar `oncontrol` → `dispatchWindowControl` with the DOM
   window as the chrome adapter.
3. Re-run `frame_live.py` + `p1t08-shell.py` + `content_slot.py` after
   wiring; extend the P1-T08 guard if the shell layout changes size.
