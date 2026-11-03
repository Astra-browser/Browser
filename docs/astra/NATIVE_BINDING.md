# Native Firefox binding — owner direction

> **Status:** owner direction, 2026-11-04. Planning only; no product code is
> changed by this document. Scope contract: `docs/astra/SCOPE.md`.
>
> This records what Astra binds to Firefox, what Astra owns, and which host
> modules should merge, stay separate, be deferred, or be retired.
>
> **Relationship to `SCOPE.md` / D-38:** this refines the current rule; it does
> not replace it. The engine is the backend, the Astra UI is still the only UI.
> "Native dialogs" means the native decision path with Astra's own prompt on
> top — never Firefox's prompt left visible. Accounts/sync remain future work
> and stay out of the current phase until a surface uses them.

## 1. Goal

Astra should use the Firefox engine's full capability and the performance work
Firefox has accumulated over years — not reimplement it beside the engine.

- Our own UI on top; native browser behaviour underneath.
- Bind as closely to Gecko as practical.
- Rust first. C++ only where it buys a measured advantage.
- Local-first. Nothing leaves the device unless the person signs in and chooses
  to sync.

## 2. Language policy

**Rust is the default** for new engine-adjacent services: the sidecar/core,
container and permission adapters, session/sync metadata, downloads glue,
blocker, and content tooling.

**JavaScript only for chrome glue** that must touch `window`, `<browser>`,
XPCOM or the chrome document. Keep it thin and event-driven; no business logic
and no duplicate state.

**C++ only when it is a real advantage**, for example:

- a Gecko internal hook that has no JS/XPCOM seam (the network blocker is the
  existing example);
- avoiding an IPC hop or a large copy on a hot path;
- an API that is C++-only.

Do not use C++ for UI, settings, dialogs policy, containers, session
bookkeeping or business logic. If a feature is roughly equal in Rust and C++,
choose Rust.

## 3. Bind natively

Priority order. "Native" means Firefox owns the state and the effect; Astra
renders it.

| Area | Native binding | Priority |
|---|---|---|
| Page and tab lifecycle | `gBrowser`/tabbrowser: `addTab`, `removeTab`, `pinTab`, `discardBrowser`, `reloadTab`, `duplicateTab`, `moveTabTo`, `selectedTab`, `browser.muted`, `SessionStore`, `TabUnloader` | P0 |
| Navigation | `browser.fixupAndLoadURIString`/`loadURI`, `goBack`, `goForward`, `reload`, `stop`, `browser.finder`, `ZoomManager`, `PrintUtils`, `AboutReader` | P0 |
| Dialogs | Native permission, auth, certificate, download and context-menu decisions; Astra UI on top | P0 |
| Containers | `ContextualIdentityService` + `userContextId`; one identity per space; `clearData` on delete | P0 |
| Boot | Native process launch + handshake with the Rust core; one startup path | P0 |
| Windows | `BrowserWindowTracker`/`OpenBrowserWindow`; real focus, close, fullscreen | P1 |
| History and favicons | Places (already native) | P1 |
| Browser-affecting settings | Firefox prefs/APIs, with Astra's settings UI | P1 |
| Downloads | Native download manager; Astra UI on top | P1 |
| Keymap execution | Astra bindings; native command execution | P1 |
| Extensions | `AddonManager` (if extensions stay in scope) | P1/P2 |
| Sync | Astra backend; native browser data read through Firefox APIs; opt-in | P2 |

**Boot does not make Gecko itself start faster.** Firefox's startup work is
already inherited by running on Gecko; the gains come from the build, the
startup graph and native prefs. "Native boot" means Astra's own startup has one
owner: launch the Rust core through Firefox's native `Subprocess`, handshake,
get the opening `event_seq`, and shut down cleanly. It should not be a JS-only
model beside a second prototype.

## 4. Own, or remove from Firefox

| Area | Decision |
|---|---|
| Telemetry | Remove/disable. Not part of Astra. |
| Updates | Astra owns updates. Firefox updater is not used. |
| AI | Astra owns it. |
| Themes | Astra owns the UI theme. The content `prefers-color-scheme` pref may stay native. |
| Accounts / sign-in / sync | Astra owns identity and backend. No Firefox Account. |
| Work | Astra owns it. |
| Notes | Astra owns it (Rust store). |
| Time | Astra owns it. |
| Settings | Astra owns the UI and the durable store. Only settings that change browser behaviour are written through native prefs/APIs. |
| Keymap UI | Astra owns the bindings. The commands they run are native where the action is native. |
| Sidebar | Astra owns it. |
| Panes | Deferred (see §6). |
| System | Only the clock is read from Firefox. Everything else is Astra's. |
| Commands | Inspect and rationalise; keep one command registry (see §6). |
| Boot | Bind natively; do not keep a second startup model. |

## 5. Dialogs and containers

### Dialogs — native backend, Astra UI

- The engine remains the source of truth. A chrome-side observer raises a Host
  event; Astra renders its own prompt; the answer goes back through a narrow
  native decision call.
- Web content can never resolve a dialog. Every resolve path requires a chrome
  actor.
- Permissions are stored with `Services.perms` so they persist and apply to the
  real content process.
- Certificate exceptions are one-load only.
- HTTP auth secrets are passed to the pending channel and never logged.
- Download decisions gate the actual file write in the native download manager.
- Astra must not show a second, Firefox-themed prompt behind its own.

### Containers — native contextual identities

- One Firefox contextual identity per Astra space, created with
  `ContextualIdentityService.create`.
- A tab joins its space's container via `userContextId` at creation.
- Moving a tab between spaces must reload it in the target container (or be
  refused). Changing the label without changing the engine context is a bug.
- Deleting a space calls `ContextualIdentityService.remove`, which clears that
  identity's cookies, storage, IndexedDB and cache.
- Private windows never use persistent containers and never sync.

## 6. Module decisions

| Module | Decision | Reason |
|---|---|---|
| `Boot.sys.mjs` + `BootSidecar.sys.mjs` | **Merge** into one native Boot supervisor | A handshake-only module and an unpackaged stdio prototype are two halves of one lifecycle. |
| `Tabs.sys.mjs` | **Merge** with the native tab lifecycle | Pin, mute, discard, session and unload cannot work while tabs are standalone `<browser>` elements. |
| `Content.sys.mjs` | **Keep, shrink** to native browser lifecycle + event bridge | It is the only module allowed to touch live `<browser>` elements. |
| `Navigation.sys.mjs` | **Merge** into the native tab/browser service | Load/back/forward/reload are real today; stop/find/reader/zoom are model-only. One state owner. |
| `Session.sys.mjs` | **Replace** with `SessionStore` + Astra metadata | No parallel session model. Use native tab state for history/scroll/form; keep space/folder/pin/sync metadata in Rust. |
| `Windows.sys.mjs` | **Merge** with the native window manager | The model does not create, focus or close real windows. |
| `Panes.sys.mjs` | **Defer/retire** | It describes UI slots but has no per-pane browser. Do not pretend it hosts content. |
| `Resources.sys.mjs` | **Split and shrink** | Tasks/notes/media belong to Astra's Rust store; page source belongs to the native browser. |
| `Commands.sys.mjs` | **Inspect, then keep one dispatcher** | Many ids are model-only or refused. Every command must be native, app-level, or removed. |
| `Keymap.sys.mjs` | **Keep the bindings, bind execution natively** | Astra owns the shortcut UI; the actions run through the native command set. |
| `Settings.sys.mjs` | **Keep for Astra settings; add a native browser-settings adapter** | Non-browser settings are ours. Browser behaviour must go through prefs/APIs. |
| `Dialogs.sys.mjs` | **Merge** into a native prompt service | Permissions/auth/cert/downloads must reach the engine, not a JS map. |
| `Containers.sys.mjs` | **Merge** into `ContextualIdentityService` | The current in-memory jars are not isolated storage. |
| `Downloads.sys.mjs` | **Bind the native download manager** | The current module is always empty. |
| `History.sys.mjs` / `HistoryCall.sys.mjs` / `Favicons.sys.mjs` / `Bookmarks.sys.mjs` | **Keep Places-backed** | These already use the real engine store. |
| `Media.sys.mjs` | **Bind `browser.mediaController` or retire** | The sidebar player is always empty today. |
| `WebExtensions.sys.mjs` | **Bind `AddonManager` or retire** | The current list is always empty. |
| `System.sys.mjs` | **Keep clock only** | Everything else is Astra's or explicitly unavailable. |
| `Accounts`, `Work`, `Notes`, `Time` | **Keep in Astra's Rust backend** | Owner-excluded from Firefox. |
| `Sidebar.sys.mjs` | **Keep as Astra UI state** | No native sidebar to drive. |
| `Search.sys.mjs` | **Keep resolver; optionally bind `Services.search`** | URL templates work; Firefox's engine/suggestion service is not used. |
| `Helpers.sys.mjs` | **Keep for OS helpers only** | Not a browser binding. |
| `Events.sys.mjs` / `HostAPI.sys.mjs` | **Keep, shrink the façade** | The event pump is the seam; the façade should expose only live modules. |

## 7. Local-first and sync

- All data stays on the device by default: history, tabs, containers, notes,
  tasks, settings, keys.
- No telemetry and no background upload.
- Sync is opt-in after sign-in, per category, with a visible list of what is
  uploaded.
- Private windows are never synced and never persisted.
- The sync server must never receive a plaintext credential; keys stay local.
- If sync is off or the account is signed out, the browser must behave exactly
  as a local browser.

## 8. Performance rules

- Use Firefox's native tab lifecycle, process model, SessionStore and
  TabUnloader instead of a parallel JS lifecycle.
- Do not keep two copies of tab/navigation state. One owner per concern.
- No JS work on hot paths: network blocking, content injection and media
  control belong in Rust/C++/native APIs.
- Keep IPC messages small and batched; the event pump already carries
  `event_seq` for resync.
- Measure before choosing C++: a C++ hook is justified only by a measured win.

## 9. Acceptance criteria

A browser surface is done only when:

1. Every visible browser action either calls the native engine or is explicitly
   labelled app-level.
2. Tab mute, discard/sleep, session restore and unload work through Firefox's
   own mechanisms.
3. Permission, auth, certificate, download and context-menu decisions reach
   the engine and return a real result.
4. Containers are real `ContextualIdentityService` identities; deleting a space
   wipes its data; moving a tab re-isolates it.
5. There is one source of truth per concern; no JS shadow model for native
   state.
6. A live probe demonstrates the effect (PSS/process drop, audio state, prompt
   resolution, wake restore) — not just a UI state change.

## 10. Open decisions

- Adopt native `gBrowser` tabs (hidden native strip) or keep standalone
  `<browser>` elements. This is the single biggest decision; most of the items
  above depend on it.
- Extensions in scope: bind `AddonManager` or remove the surface.
- Downloads: native manager UI vs Astra UI over native transfers.
- Media sidebar: bind the native controller or remove the player.
- C++ criteria: which hooks, if any, justify a C++ patch after measurement.
