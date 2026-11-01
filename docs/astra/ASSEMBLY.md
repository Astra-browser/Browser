# Astra shell assembly (P3-T13)

> Status: frame builders (P3-T03), tab strip (P3-T04) and split renderer
> (P3-T06) mounted in `Shell.svelte`; `win.__astraHost` extended with
> `Windows` (+ `Frame` dispatch). `jar.mn` registration of `frame.css` /
> `Frame.sys.mjs` already landed (P3-T03), so no packaging change here.

## 1. Layout

```
.astra-shell.astra-frame [data-astra-frame]  (fills #astra-root, column)
├─ [data-astra-titlebar]   (createTitlebar: drag strip + title + min/max/close)
├─ [data-astra-toolbar]    (createToolbar: new-tab / split / toggle-fullscreen)
└─ .astra-frame-body  (row)
   ├─ .astra-sidebar-col (220px rail)
   │  ├─ [data-astra-sidebar]  (createSidebar: Tabs/Notes nav)
   │  └─ .astra-tabs-mount → [data-astra-tabs] (mountTabStrip, vertical, P3-T04)
   └─ .astra-main (column, flex:1)
      ├─ [data-astra-urlbar]   (mountUrlBar, P1-T10, unchanged)
      ├─ .astra-split-mount → [data-astra-split] (mountSplit, P3-T06;
      │   hidden until ≥2 slots so the P1-T10 content slot keeps the column)
      └─ [data-astra-content]  (host.Content.mount, P1-T10, unchanged)
<details class="astra-about"> (Shell status + Hello, P1-T08, kept rendered)
```

Fullscreen (`data-astra-fullscreen="true"` on the frame) hides
titlebar/toolbar/sidebar-col via the shell stylesheet; the chrome agent
sheet (`frame.css`, registered P3-T03) enforces the same rule in the live
window. Tab strip is vertical by design (see `tab-strip.css`), so it lives
in the sidebar column; the split grid lives in the main column above the
single content slot (S-01: split cells own future per-slot browsers; the
P1-T10 `Content.mount` element is untouched).

## 2. `win.__astraHost` seam

```js
win.__astraHost = {
  Tabs, Navigation, Panes,        // P1-T10, unchanged
  Windows,                        // P3-T13: host.Windows model (focus/fullscreen/…)
  Frame: {                        // P3-T13: bound to this window's host + adapter
    version,                      // FRAME_VERSION passthrough
    actions,                      // WINDOW_ACTIONS passthrough
    dispatchWindowControl(opts),  // resolves window_id (focused ?? "win-1"),
                                  // request_id default, then dispatches
  },
  addEventListener,
};
```

Set only when a DOM window exists and the seam is absent (same gate as
P1-T10). `Frame` is `null` outside the browser (module not importable);
`Windows` is always the live `host.Windows` from `loadHost()`.

## 3. Window-control flow

Titlebar `oncontrol(action)` → `handleControl` →

```
Frame.dispatchWindowControl(host, chromeAdapter,
  { action, window_id, request_id })
```

- `window_id` = `host.Windows.list().focused_window_id ?? "win-1"`.
- `chromeAdapter` is built from the DOM window and exposes **only** the
  ops the window actually implements (`minimize`/`maximize`/`restore`);
  a missing op keeps reporting `unsupported_chrome_op` (never a silent
  no-op) per `FRAME.md` §3.
- `close` → `host.Windows.close` (model refuses the last window);
  `toggle-fullscreen` → get + setFullscreen, then the shell mirrors the
  result to `data-astra-fullscreen` and `win.fullScreen`.
- `window.fullscreen-changed` host events (whoever emits them) are mirrored
  the same way; `tab.*` events refresh the split tab list and the titlebar
  title (`Astra — <active title>`, falls back to `Astra`).

Toolbar actions: `new-tab` → `Tabs.create(about:blank)`; `split` →
`splitApi.split(null)` (the `onChange` hook unhides the grid at ≥2 slots,
re-hides below); `toggle-fullscreen` → same dispatch as the titlebar path.

## 4. P1-T08 / P1-T10 guards (why they still hold)

- `#astra-root` keeps non-zero size: the frame is `flex:1`, the content
  slot keeps `min-height:200px` and the browser flexes inside it.
- `Hello Tab` text stays in `#astra-root`: `<Hello/>` still renders in the
  status `<details>`. Shell-owned chrome text before it is minimal
  (titlebar + toolbar + sidebar ≈ 20 chars); the dynamic tab strip follows
  the same budget the live suites already tolerate.
- URL bar + content slot wiring is byte-identical to P1-T10
  (`mountUrlBar`, `host.Content.mount`, same error paths).

## 5. Verification (P3-T13 worker)

- `node tests/contract/shell_assembly.mjs` — 57 checks PASS (static wiring
  pins + behavioral: real builders/strip/split/Frame.sys.mjs over the real
  Windows model with a fake DOM, incl. dispatch routing and the
  last-window / unsupported_chrome_op / invalid_window_action guards).
- No-regress, stub side (no engine checkout in this lane):
  `content_slot.mjs`, `frame_model.mjs`, `slots_model.mjs`,
  `hostapi_v1.mjs`, `tab-strip-model.test.mjs`, `split-model.test.mjs`,
  `split-renderer.test.mjs` — all PASS (see commit message).
- Live suites (`p1t08-shell.py`, `content_slot.py`, `frame_live.py`,
  `slots_live.py`) need the built binary (`engine/obj-astra-linux`, not
  present in this lane's checkout) — re-run at merge time.
- `bun run build` (ui/shell) clean; rebuilt
  `overlay/astra/chrome/shell/shell.mjs|css` committed with the source.
- `tools/brand-lint.sh` clean.
