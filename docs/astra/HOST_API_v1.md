# Host API v1

> **Status:** v1 spec, P2-T06 (2026-11-02). Supersedes the P1-T10 working
> notes (folded in here; `HOST_API_v1_T10.md` removed). The JSON schemas
> under `overlay/astra/host/schemas/` are authoritative for the protocol;
> this document explains the modules, the envelope, and the live-binding
> notes. `HOST_API_VERSION` stays **1** — the v1 surface grew without
> breaking the P1-T10 protocol, so the P2-T08 bridge and P1-T10 tests are
> unaffected.

## Modules

All modules are pure logic with no Firefox internals, importable both as
chrome ES modules (`resource://astra/host/*.sys.mjs`) and from Node
contract tests — except `Content.sys.mjs`, which is the single chrome
binding allowed to touch live browser elements.

| File | Owns |
|---|---|
| `Events.sys.mjs` | event pump; every event carries monotonic `event_seq` (§5.4); `eventsSince(seq)` replays the ring buffer (cap 500) for gap resync, flagging `gap: true` when eviction forces a full snapshot |
| `Boot.sys.mjs` | `handshake` (version negotiation via `min_host_api_version`, default-window setup, opening `event_seq`), `status`, `shutdown` |
| `Windows.sys.mjs` | multi-window model: `create` (incl. `private`), `close` (closes the window's tabs, refuses the last window), `focus`, `setFullscreen`, `setTitle`, `get`, `list` |
| `Tabs.sys.mjs` | tab model: stable `astra_tab_id`s, `window_id` association, ordering, pin/discard/mute, selection, per-tab history stacks; `create`/`get`/`select`/`close`/`list`/`move`/`duplicate`/`pin`/`unpin`/`discard`/`wakeup`/`setTitle`/`setMuted` |
| `Navigation.sys.mjs` | `loadURL`/`goBack`/`goForward`/`reload`/`stop`, per-tab zoom (`setZoom`/`getZoom`, clamped 0.3–3.0 mirroring FullZoom), find-in-page (`findInPage` + `setFindResult` live-count ingress), `print` dispatch, reader-mode flag (`setReaderMode` + `setReaderAvailable` ingress); `__commitExternal` folds external loads (link clicks, history.pushState) into history + events |
| `Panes.sys.mjs` | side-panel / Work-canvas surfaces: `show`/`hide`/`list` plus `attach` (shell `slot` + optional tab mirror), `detach`, `setRect`, `get`, and the `check` generation guard (attach/detach bump `generation`; stale producers drop work) |
| `Content.sys.mjs` | chrome binding: mounts one remote content `<browser>` into the shell slot and drives loads through the stub (`nav.committed` → browser follows); `attachTabBrowser` registers a tabs progress listener (`makeProgressListener`) feeding external loads/titles back into the model; `applyZoom`/`printPage` perform live zoom/print best-effort |
| `HostAPI.sys.mjs` | façade: re-exports all modules + `addEventListener`/`emit`/`eventSeq`/`eventsSince` + `__resetForTests` (P1-T05 shape preserved) |
| `schemas/*.json` | `boot`, `windows`, `tabs`, `navigation`, `panes`, `events` schemas |

History mirroring into Places (`:visited`) is owned by P2-T07 (separate
lane/files); session snapshot/restore is P2-T09.

## Protocol (Appendix C envelope)

- Every call echoes `request_id` and carries `host_api_version: 1`;
  failures return `{ request_id, host_api_version, error: { code, message } }`
  (`no_such_tab`, `no_such_window`, `last_window`, `invalid_url`,
  `invalid_index`, `invalid_zoom`, `invalid_query`, `invalid_direction`,
  `invalid_title`, `invalid_slot`, `invalid_rect`, `no_such_pane`,
  `incompatible_host`).
- Every event is `{ event_seq, type, data }` with session-monotonic
  `event_seq`. Event types: `boot.ready/shutdown`,
  `window.created/focused/closed/fullscreen-changed`,
  `tab.created/updated/moved/closed/pinned/unpinned/discarded/restored`,
  `nav.started/committed/stopped/zoom-changed/find-result/print-requested/reader-changed`,
  `pane.shown/hidden/attached/detached/rect-changed`,
  `content.title-changed/location-changed`.
- `request_id`s are `crypto.randomUUID()` from the UI.

## Measured platform constraints (ESR 153)

1. **No `Services.sys.mjs`.** `resource://gre/modules/Services.sys.mjs`
   does not exist in this tree; chrome windows still expose the `Services`
   lazy global — `Content.sys.mjs` reaches it via
   `container.ownerDocument.defaultView.Services`.
2. **Non-remote dynamic browsers are inert.** A `type="content"`
   `<browser>` without `remote="true"` gets a docshell whose loads
   silently never commit (no progress events). `remote="true"
   remoteType="web" maychangeremoteness="true"` navigates and reports
   title/`currentURI` normally (verified: `contentTitle` read back in
   contract test).
3. **Marionette chrome sandbox ≠ window compartment.**
   `importESModule` in a test script yields a separate module evaluation
   with its own store. Window-instance assertions drive the
   `win.__astraHost` seam; module-protocol assertions import from a
   test-only `resource://astraT06/` substitution pointing at
   `overlay/astra/host/` (no build-tree copies). Both paths run in
   `tests/contract/hostapi_v1.py`.
4. **Live tab APIs verified against the pinned source** (read-only):
   `gBrowser.addTab(uri, { triggeringPrincipal, inBackground })`
   (triggeringPrincipal mandatory),
   `gBrowser.removeTab`, `gBrowser.selectedTab`,
   `gBrowser.moveTabTo(tab, { tabIndex })`, `pinTab`/`unpinTab`,
   `discardBrowser(tab)`, `reloadTab(tab)`, `duplicateTab(tab)`
   (`browser/components/tabbrowser/content/tabbrowser.js`).

## Verification

- `node tests/contract/content_slot.mjs` — 33 stub checks (P1-T10
  protocol intact: request_id echo, event_seq monotonic, back/forward
  stack, errors). PASS — must stay green for P2-T08/P1-T10.
- `node tests/contract/hostapi_v1.mjs` — 262 stub checks: every v1
  function incl. error codes, window-close-tabs cascade, duplicate history
  copy, same-URL external reload, generation staleness, ring eviction gap,
  progress-listener fakes. PASS.
- `python3 tests/contract/hostapi_v1.py` — 30 live checks in the built
  binary (v1 sources via `astraT06` substitution + baked-seam envelope
  compat). PASS.
- `python3 tests/contract/content_slot.py` — live slot + URL bar via the
  baked build (P1-T10 no-regress). PASS.
- `python3 tests/contract/p1t08-shell.py` — 5/5 PASS (no regression).

## Known gaps (post-v1)

- In-page navigations now feed back through progress listeners, but only
  for tabbrowsers `attachTabBrowser` watches; the shell wires the single
  content slot (multi-pane watching lands with Panes UI, P3).
- One default window at boot; live `win.focus()`/fullscreen mirroring and
  the custom titlebar region are shell work (this module owns the model).
- Content browser has no context menu, find UI, or permission UI (P3-T09).
- Live print/reader depend on `PrintUtils`/AboutReader presence;
  the model records intent either way.
