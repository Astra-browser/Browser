# Known limits after the native merge (2026-11-04)

Recorded so the next phase does not rediscover them as regressions. Each item
has an owner phase; none is a silent fallback.

## Native surfaces still using Firefox UI

| Surface | Today | Next |
|---|---|---|
| Save-password doorhanger after HTTP auth | `LoginManagerAuthPrompter` still shows Firefox's save prompt | decide with `PASSWORD_DECISION.md` (Option B: signon off) |
| Print | `PrintUtils.startPrintWindow` (Firefox print window) | Astra print UI |
| Tab context menu, split, drag/drop, menu popups | the app calls `tab_menu_popup`, `chrome_menu_popup`, `tabs_split`, `tab_drop`, ... which are unrouted | P10: implement the Astra menu/split or remove the controls |
| Extension toolbar action buttons | `extension_action_*` unrouted; actions list is empty | P9b |
| Certificate error page | detected from the error-page flag; the engine page can flash before the app pane replaces it | optional `LoadURIDelegate` actor |

## Features with no backend yet

Popup blocking and external-protocol cards have no producer yet, so the
PageRequestCard only appears for HTTP auth; `Tabs.answerPageRequest` is wired
and refuses an answer for a card that is not on screen. `Work` author/query/execute, human takeover, model providers, accounts, voice,
page assist, blocker, browser import/export, updates, profiles, downloads
manager, resource media, notes `reveal`, and the tasks/notes Rust store. The
wiring inventory is in the audit report; the next phase (P8/P10) owns them.
`unknown_command` for any of these is a product gap, not a deferral to ship.

## Data and contexts

- **Multi-window organisation:** one window is the writer (`Metadata` owner);
  a second window's spaces/pins are not merged into the store yet (P5b-3). The
  owner is released on close and the next window takes over.
- **Folders/sync:** the UI's tab folders are `localStorage`; the Rust
  `SessionSnapshot.folders` is ready but the host has no folder model.
- **Page source:** `PageSource` is real but the shell driver is still the
  privileged `fetch` (fresh GET, not the tab's cached document). Private
  windows are refused. Native view-source is P8-1b.
- **Certificates:** a temporary override is cleared on the next commit (true
  one-load); it is host:port:OA scoped, like the engine's own exception.
- **Media player:** the projection and transport are live, but the hidden
  display has no audio device, so its live probe skips (exit 2). Verify on a
  headed machine with `tools/perf/stress/media_player_probe.py`.
- **WebRTC:** screen share, audio capture, speaker selection, add-on prompts,
  unsafe delegation and non-web/insecure origins keep the native prompt on
  purpose. NTLM/Negotiate/password-only auth is cancelled, never shown natively.

## Known placeholder assets

- `astra-icon.png`, `astra-icon@2x.png` and `astra-wordmark.svg` are the
  deliberate placeholders described in `OWNER_QUESTIONS.md` Q1 (the icon is a
  flat square). They now load (the Settings/Callout paths used an absolute
  `chrome://astra/` URL that does not exist); replacing the art is an owner
  task, not a wiring gap.

## Verification gaps

- UI-tour screenshots are captured, but the visual baseline still needs a human
  pass for pixel parity.
- Performance budgets for tab-switch/scroll are proposals (p95 ≤ 100 ms / 32 ms);
  the latest run is recorded in `out/perf-final`.
