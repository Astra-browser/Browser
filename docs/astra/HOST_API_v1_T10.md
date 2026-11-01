# Host API v1 — P1-T10: content slot + URL bar through the stub (temporary)

> **Status:** P1-T10 working notes, 2026-11-02. The orchestrator folds this
> into the spec; the JSON schemas under `overlay/astra/host/schemas/` are
> authoritative for the protocol. P2-T06 replaces the stub models with live
> `gBrowser` bindings and keeps this protocol.

## What P1-T10 added

One live tab in the window; a minimal URL bar drives navigation through the
Host API stub. Modules (all pure logic, no Firefox internals — Node
contract tests import them by path):

| File | Owns |
|---|---|
| `overlay/astra/host/Events.sys.mjs` | event pump; every event carries monotonic `event_seq` (§5.4) |
| `overlay/astra/host/Tabs.sys.mjs` | tab model: `astra_tab_id`s, selection, per-tab history stacks; `create`/`select`/`close`/`list` |
| `overlay/astra/host/Navigation.sys.mjs` | `loadURL`/`goBack`/`goForward`/`reload` over the history stack |
| `overlay/astra/host/Panes.sys.mjs` | minimal side-pane stub (`show`/`hide`/`list`); full version in P2-T06 |
| `overlay/astra/host/Content.sys.mjs` | chrome binding: mirrors stub state into a real remote `<browser>`; the ONLY module touching live browser elements |
| `overlay/astra/host/HostAPI.sys.mjs` | façade: re-exports all modules + `Boot.handshake`, `addEventListener`, `__resetForTests` (P1-T05 shape preserved) |
| `overlay/astra/host/schemas/*.json` | `tabs`, `navigation`, `panes`, `events` schemas |

UI (`ui/shell/src/`, chrome-privileged Svelte bundle):

| File | Role |
|---|---|
| `Shell.svelte` | layout: bar mount + `[data-astra-content]` slot + P1-T08 hello (kept rendered — P1-T08 contract stays green) |
| `urlbar.js` / `urlbar.css` | URL bar with back/forward/reload. **Imperative XHTML-namespaced DOM**, not a Svelte template: the chrome XUL document sanitizer strips `<button>`/`<form>`/`<input>` from `innerHTML` fragments (measured 2026-11-02; `<div>` survives, which is why P1-T08 rendered) |
| `host.js` | runtime `resource://astra/host/*.sys.mjs` imports (`/* @vite-ignore */` so Vite leaves them untouched) |

## Protocol (Appendix C envelope)

- Every call echoes `request_id` and carries `host_api_version: 1`; failures return `{ request_id, host_api_version, error: { code, message } }` (`no_such_tab`, `invalid_url`).
- Every event is `{ event_seq, type, data }` with session-monotonic `event_seq`.
- Events: `boot.ready`, `tab.created`, `tab.updated` (incl. `selected`, `canGoBack/Forward`), `tab.closed`, `nav.committed` (incl. `reloaded` on reload), `pane.shown`, `pane.hidden`.
- `request_id`s are `crypto.randomUUID()` from the UI.

## Measured platform constraints (ESR 153, for P2-T06)

1. **No `Services.sys.mjs`.** `resource://gre/modules/Services.sys.mjs` does not exist in this tree; chrome windows still expose the `Services` lazy global — `Content.sys.mjs` reaches it via `container.ownerDocument.defaultView.Services`.
2. **Non-remote dynamic browsers are inert.** A `type="content"` `<browser>` without `remote="true"` gets a docshell whose loads silently never commit (no progress events). `remote="true" remoteType="web" maychangeremoteness="true"` navigates and reports title/`currentURI` normally (verified: `contentTitle` read back in contract test).
3. **Marionette chrome sandbox ≠ window compartment.** `importESModule` in a test script yields a separate module evaluation with its own stub store. Tests drive the window's instance through the `win.__astraHost` seam (chrome code already has these capabilities; the seam adds none).

## Known gaps (P2-T06)

- In-page navigations (link clicks, history.pushState) do not feed back into the stub — needs progress listeners.
- One tab only; tab strip, session restore, and real `gBrowser` ownership (D-05) are P2 work.
- Content browser has no context menu, find, or permission UI (P3-T09).

## Verification

- `node tests/contract/content_slot.mjs` — 33 stub checks (request_id echo, event_seq monotonic, back/forward stack, errors). PASS.
- `python3 tests/contract/content_slot.py` — 12 browser checks incl. P1-T08 no-regress subset (hello rendered, toolbox+tabbox hidden), URL-bar submit navigates a live page, back/forward round-trip, `event_seq` monotonic. PASS.
- `python3 tests/contract/p1t08-shell.py` — 5/5 PASS after the change (no regression).
- GUI (headless + headed spot-check): URL bar, 1366×376 live content browser rendering local fixtures, back/forward buttons.
