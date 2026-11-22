# Known limits after the native merge (2026-11-04)

Recorded so the next phase does not rediscover them as regressions. Each item
has an owner phase; none is a silent fallback.

> **Status 2026-11-20.** This file is kept as the 2026-11-04 record; the rows
> marked **resolved** below were re-checked against the code and the running
> build in the full-product E2E audit, and the file's original wording is left
> in place so the history stays readable. Open items are marked **open**. Read
> `docs/astra/E2E_AUDIT_2026-11-20.md` for the current defect list (it, not this
> file, is the "do not re-report" list for anything after 2026-11-04). The
> probe-level drift behind the old rows is in `out/audit/findings/probes.md`.

## Native surfaces still using Firefox UI

| Surface | Today | Next |
|---|---|---|
| Save-password doorhanger after HTTP auth | **open** — `LoginManagerAuthPrompter` still shows Firefox's save prompt | decide with `PASSWORD_DECISION.md` (Option B: signon off) |
| Print | **open** — `PrintUtils.startPrintWindow` (Firefox print window); no Astra print surface exists | Astra print UI (E2E audit, open P2) |
| Tab context menu, split, drag/drop, menu popups | **resolved 2026-11-20** — the app draws its own menus (`tab-menu.ts`, `.shell-menu`, 0 native XUL popups), split is native `addTabSplitView` panes with a host resizer, and `tabs_split`/`tab_drop` are routed. The old sentence ("the app calls ... which are unrouted") describes the 2026-11-04 build | keep dead leftovers out: the dead `tab_menu_popup`/`chrome_menu_popup` pages and the divider overlay's three commands are `unused` in the manifest, and their callers were removed on 2026-11-22 (nothing emits `astra:layout`, and the host owns the native resizers) |
| Extension toolbar action buttons | **resolved 2026-11-20** — `extension_action_invoke` is routed, the action list is populated, and `webext_action_probe.py` is registered in the suite | — |
| Certificate error page | **open** — detected from the error-page flag; the engine page can flash before the app pane replaces it | optional `LoadURIDelegate` actor |

## Features with no backend yet

The 2026-11-04 list here is out of date in both directions. Re-checked
2026-11-20:

- **Shipped since:** browser import/export (`Migration`), downloads manager
  (`Downloads`), profiles (`Profiles`), notes (`Notes`, live probe PASS),
  resource media and media import (`Resources`, `media_player`/`media_import`),
  time/focus (`Time`), tasks (`Resources`). Updates has a host module too
  (`System.updateStatus`), but it answers `unavailable` because the build ships
  `--disable-updater`. `update_highlights` and `update_relaunch` are routed to
  honest answers (`null` / `false`); the day an updater lands they read the
  parked update instead of starting from a silent no-op.
- **Still behind an off build flag, by decision (D-48):** Work, the AI/assist
  and voice surfaces, page styles, and the account/plan pages. Their commands
  are in the wire baseline as known-unrouted, not unknown.
- **Still genuinely missing:** popup-blocking and external-protocol cards (the
  card component exists, no producer raises it), the first-run onboarding page
  (built but neither staged nor opened), the launcher window (the panel
  document is not packaged, so `panel_intent`/`panel_layout` have no surface),
  and print. Haptics and trackpad swipe have no platform source on Windows
  (`haptic`, `swipe_region`), so their callers were removed rather than left
  calling a command nothing answers.
- **Window-close handshake — resolved 2026-11-22.** `overlay/astra/host/Close.sys.mjs`
  intercepts the window's own close, announces `astra:resource-close`, waits for
  the app's `resource_close_ready(token, success)` and then closes; a 12.5 s cap
  means an app that never answers cannot trap the window. The live probe caught
  a real bug in the first version: a `<dialog>` close inside the
  chrome-privileged app frame reached the window's capture listener and shut the
  browser when the split picker closed. The listener now ignores any event whose
  target is not the window, and the contract test pins that case.

`unknown_command` for a flag-off surface is expected; for a shipped surface it
is a product gap. The rule did not change — the list of shipped surfaces did.

## Protected content (DRM / Widevine)

- **L3 only, and it works by default.** The Linux build compiles Widevine
  (`MOZ_EME_MODULES: ['widevine']`) and `mozilla.cfg` enables EME, so a site
  that offers Widevine L3 can play protected audio and video. Settings →
  Privacy → Protected content turns it off again (`media.eme.enabled`).
- **No L1 and no 4K.** Widevine L1 needs a hardware TEE with the CDM inside
  it; Gecko only ships the L1 CDM on Windows x64 (`MOZ_WMF_CDM && _M_AMD64`),
  never on Linux. So Netflix and other OTT services are capped at their L3
  tiers here (typically 720p–1080p where the service allows Firefox); 4K/HDR
  needs L1 or PlayReady SL3000 and is out of reach on this target.
- **The CDM is downloaded, not bundled.** The Widevine binary comes from
  `update.googleapis.com`, which is a signed-off `KEEP` in
  `tools/endpoint-audit/classify.toml`. Turning DRM off removes the module;
  turning it back on re-fetches it.
- **No engine-owned DRM UI.** `browser.eme.ui.enabled` is false: the native
  "enable DRM" doorhanger and about:preferences checkbox never show. Astra's
  switch is the only control (`tests/contract/protected_content.mjs` enforces
  the wiring).

## Page loading

- **The cover ends at the document commit**, not at true first paint. The
  commit is the earliest reliable signal the chrome process gets; paint timing
  lives in the content process, so a document that commits and then renders
  slowly shows the stage ground for that gap (Firefox behaves the same). The
  tab row's spinner keeps running until the document actually finishes.

## Data and contexts

- **Multi-window organisation:** one window is the writer (`Metadata` owner);
  a second window's spaces/pins are not merged into the store yet (P5b-3). The
  owner is released on close and the next window takes over.
- **Folders (corrected 2026-11-20):** there is no folder store anywhere. The
  app no longer keeps tab folders in `localStorage`, the host emits only
  `{type: "tab"}` sidebar nodes and has no folder method, and no route or
  command creates one — `FolderRow.svelte` and the `{type: "folder"}` binding
  are render-only. The Rust `SessionSnapshot.folders` is ready and validated;
  the capture side is missing. Open decision: implement the host folder model
  or remove the binding and the row (E2E audit F7).
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

- **DevTools teardown noise is patched out.** ESR 153 logs `No such
  JSProcessActor 'DevToolsProcess'` (bug 2044741) and the `getGrids`/`pagestyle`
  teardown family (bug 1944477) while a toolbox closes, and logs `Unable to find
  target with innerWindowId` for `network-event` resources that arrive after
  their document's target died. `patches/ASTRA-0010-devtools-teardown-races.patch`
  defers the process-actor unregistration to an idle turn, tolerates a destroyed
  watcher in the process actor, and drops the late-resource error (the resource
  was already dropped silently). Re-check this patch when the pinned engine is
  bumped: both bugs are fixed or being fixed upstream (2044741, 2056174).
- UI-tour screenshots are captured, but the visual baseline still needs a human
  pass for pixel parity.
- Performance budgets for tab-switch/scroll are proposals (p95 ≤ 100 ms / 32 ms);
  the latest run is recorded in `out/perf-final`.

## Blocker (D-42)

The ad/tracker blocker is live (see `BLOCKER.md`). Remaining limits are
specific, not "unwired": `$redirect` blocks but does not substitute a redirect
body; rare multi-operator procedural filters are ignored; compilation is
synchronous on the main thread at install/update. Private windows block but
never count. No Brave rewards, telemetry, P3A or update host is present.

## Fingerprinting (D-43)

FPP is on with a strengthened target set (`FINGERPRINTING.md`). It does not
spoof the user agent, timezone or screen because that breaks real layouts and
some sites; RFP remains opt-in. FPP reduces the cheap high-entropy surfaces
(canvas, GPU, audio, fonts, display metrics), not unlinkability as a whole.

## Extension platform (Chrome + Firefox, 2026-11-08)

- **MV3 service workers are event pages.** `extensions.backgroundServiceWorker.enabled`
  is locked off in this engine. The adapter moves the worker to
  `background.scripts`; `clients`, `skipWaiting`, `waitUntil` and
  `install`/`activate` are best-effort shims, not a real ServiceWorkerGlobalScope.
  True worker-only behaviour (fetch interception, persistent worker state) does
  not run.
- **Dynamic `importScripts` cannot be expanded.** Static string-literal calls
  are resolved into ordered background scripts; a computed argument is reported
  as a limitation and the call will fail where it runs.
- **Temporary install is the signed-build policy.** An adapted Chrome XPI is
  not Mozilla-signed, so this build installs it as a temporary add-on and
  restores it at each start. It does not use the AMO update channel; Astra
  stages each update itself. A build that allows unsigned add-ons installs
  persistently.
- **Chrome-only APIs remain missing**, including `debugger`,
  `desktopCapture`, `tabCapture`, `offscreen`, `system.*`, `tts`,
  `fontSettings` and the ChromeOS namespaces. The review names the ones the
  package actually calls and the verdict becomes Limited.
- **Store acquisition is not an official API.** The Chrome Web Store package is
  fetched through Chrome's update service; Google can change it. The CRX3
  signature and package digest are verified, and file import is the supported
  fallback. No Google store-policy or publisher-identity trust is claimed
  beyond the signing key.
- **V8/SpiderMonkey differences are not translated.** Syntax and runtime
  semantics the engine does not implement stay unsupported.
- **Firefox add-ons still follow the engine's signature and update model**;
  the Chrome intake does not replace or weaken it.
- **The compatibility scan is lexical.** It inventories API names and
  behavioural strings; it does not execute code or prove a code path runs. A
  clean security report is explicitly not a safety guarantee.
- **Chrome native-messaging host manifests are not imported.** Gecko reads
  Firefox's host directories, not Chrome's. A host registered only for Chrome
  is not found; `connectNative` fails rather than returning a fake port.
- **Cross-extension/cross-profile isolation is the engine's boundary.** The
  platform does not weaken it, but it does not reimplement it. The fault probe
  covers a crashing extension leaving the browser and a healthy extension
  working; it does not inject OS-level process kills or test another profile's
  private data.
- **Chrome packages do not poll a store for updates in the background.** An
  update is fetched and reviewed on request; adapted XPIs do not use the AMO
  update channel.
- **Chrome Web Store pages say “Switch to Chrome”.** That page feature is not
  used and cannot be trusted to install in Gecko. Astra draws its own
  always-visible “Add to Astra” callout at the top of the sidebar and installs
  the same CRX3 package itself. No Chrome user-agent spoof or page shim is
  installed.
- **Google CAPTCHA is not bypassed.** Google may show an image challenge to a
  fresh or automated session. New profiles default to DuckDuckGo; Google stays
  selectable. Astra does not solve, outsource or bypass CAPTCHAs.
- **A Chrome package can ship a Firefox id and root-relative paths.** Astra
  forces the Chrome-derived id, normalizes every extension-relative path and
  maps `chrome-extension://` web-accessible-resource matches to Gecko
  `extension_ids`; a package that still fails Gecko manifest validation is
  reported with the engine's exact validation error.
- **Large legitimate packages are allowed.** The uncompressed cap is 512 MiB
  with a 96 MiB container cap; AdBlock Plus (317 MiB uncompressed, 71 MiB CRX)
  installs. The XPI writer streams entry by entry and the sidecar call allows
  180 s for inspect/stage.

