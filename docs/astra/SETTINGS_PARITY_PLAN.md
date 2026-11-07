# Browser settings parity plan

> Status: active, 2026-11-05. Scope contract: `docs/astra/SCOPE.md` (D-38).
> Every item below must end in native Firefox state/API and a live probe; no
> UI-only switches, no second model.

## Why this plan exists

The Settings page now stores values (native prefs where Firefox has one,
`astra.settings.*` otherwise) and the Appearance light/dark switch, startup
persistence and theme command path are fixed. The remaining items are not
storage bugs: the **consumer** of each setting is missing, or the UI is a
placeholder. The owner’s list is reproduced below with the real cause.

## Lanes

Each lane runs in its own worktree/branch, edits only its owned files, adds a
contract/unit test, and is merged only after the live probe passes. Generated
bundles (`overlay/astra/chrome/app/assets`, `engine/`) are rebuilt once in the
integration branch, never committed from a lane.

| Lane | Branch | Worktree |
|---|---|---|
| Integration | `fix/browser-settings-parity` | main checkout |
| Tabs | `fix/settings-tabs` | `Astra.worktrees/tabs` |
| New Tab + Search | `fix/settings-newtab-search` | `Astra.worktrees/newtab-search` |
| Privacy | `fix/settings-privacy` | `Astra.worktrees/privacy` |
| Downloads + Profiles | `fix/settings-downloads-profiles` | `Astra.worktrees/downloads-profiles` |
| Time + Performance | `fix/settings-time-performance` | `Astra.worktrees/time-performance` |
| Material + Zoom + Home | `fix/settings-material-zoom-home` | `Astra.worktrees/material-zoom-home` |

## Lane 1 — Tabs behaviour

| Setting | Current state | Native owner | Change |
|---|---|---|---|
| New tab position | pref written; `Tabs.create` always pushes to end; sidebar renders model order | `browser.tabs.insertAfterCurrent`, `browser.tabs.insertRelatedAfterCurrent`, `gBrowser.addTab({tabIndex})` | Read the setting in `Tabs.create`; insert after the selected tab; pass the index to `Content.ensureTab`. Live: create a tab from the middle of three. |
| Links from other apps | native external pref written; `__adoptNative` pushes to end; `new-tab` resolves through `browser.link.open_newwindow` | `browser.link.open_newwindow.override.external` (7/3/-1) | Adopt at the native tab’s position; resolve `new-tab` against `tabs.new-position` and re-apply when it changes. Live: `openURI(..., OPEN_EXTERNAL)` from the middle. |
| After closing a tab | Astra-only; `Tabs.close` always next then previous | No pref for next/previous; `browser.tabs.selectOwnerOnClose` for recent/owner | Implement `next`/`previous`/`recent` in `Tabs.close` with an MRU stack (bounded, torn down per window). Live: A/B/C. |
| Close buttons | UI consumer exists (`data-close-buttons`); pinned/essential rows excluded | No ESR pref; native attribute `closebuttons` | Verify the packed bundle updates `data-close-buttons`; decide and document pinned/essential behaviour. Live: computed opacity with `always`/`hover`. |
| Archive | No reader; `Tabs.discard` exists | No pref; SessionStore keeps closed-tab undo | Add a host archive scheduler that closes idle Today tabs after the chosen age (history stays), with teardown; do not map it to `performance.after`. Live: 12h + clock seam. |
| Automatic PiP | pref written; tab switch never hides the outgoing content, so `VideoTabHidden` never fires | `media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled` + `docshellState` | Deactivate the outgoing browser and activate the incoming one on select (preserve layers false). Live: audible loopback video + tab switch → PiP. |

## Lane 2 — New Tab and Search

| Setting | Current state | Native owner | Change |
|---|---|---|---|
| Background image | `media_import` unrouted; no picker; `astra-media.localhost` not registered; picker row only appears after the pref is already `image` | `nsIFilePicker`, persisted profile media | Route `media_import`, store/validate bytes, serve them, show the picker independently. Live: choose a PNG and render it. |
| Search suggestions | pref written; `Search.newtabSearch`/`launcherSearch` emit one search row; no provider | `browser.search.suggest.enabled` + `Services.search.defaultEngine` suggest URL | Gate on the setting; fetch/debounce by request id; emit suggestion rows before the search row. Live: `rust` → ≥2 rows; off → 1. |
| Custom engine | UI writes `{searchTerms}`; host requires `%s` | Astra resolver | Accept both tokens (normalise once) and update the hint. Live: custom URL query. |
| `!g !d !b !br` | Not parsed anywhere | Astra resolver | Parse leading bang → engine override before URL detection. Live: each bang lands on its host. |
| Trackers figure | calls unrouted `blocker_stats`, renders a fabricated 0 | Blocker stats | Route stats (Lane 3) or hide the figure when unavailable. Live: non-zero or absent, never a fake 0. |

## Lane 3 — Privacy

| Setting | Current state | Native owner | Change |
|---|---|---|---|
| Block ads and trackers | **live** (D-42): `Blocker.sys.mjs` installs the Brave-derived catalog through `@astra/blocker;1`; the C++ hook cancels pre-connect | `mozilla::AstraBlocker`, `astra.blocker.enabled`, `nsIAstraBlockerService` | Done: status/shield/site pause/stats + catalog (`blocker_lists`) and parameters (`blocker_configure`). Live: `blocker-probe.py` — loopback ad image cancelled (0 server hits), cosmetic hide, settings render. |
| Filter lists | **live** (D-42): catalog + cache + HTTPS refresh; "Update lists now" and the 24 h default schedule | `blocker/` catalog, `Blocker.sys.mjs`, native service | Done: list membership, interval, cosmetic/scriptlet switches, stats reset; failed updates keep the previous engine. Live: `blocker-probe.py` (80 lists, 155 226 rules, schedule round-trip). |
| Site settings | “unavailable”; `site_permissions`/`site_permission_set` unrouted | `SitePermissions.getAllByPrincipal/getForPrincipal/setForPrincipal/removeFromPrincipal` | Add list/set host methods + routes. Live: seed a camera decision, see/deny it. |
| Clear browsing data | `browsing_data_call` unrouted | `ClearDataService`, `Sanitizer` | Add BrowsingData module for the five ranges + history/downloads/cookies. Live: counts before/after. |

## Lane 4 — Downloads and Profiles

| Setting | Current state | Native owner | Change |
|---|---|---|---|
| Download location / ask | `Downloads.sys.mjs` stub returns `supported:false`, `directory:null`; UI shows “loading” forever | `Downloads.getList/getPreferredDownloadsDirectory`, `browser.download.dir/folderList/useDownloadDir`, `nsIFilePicker` | Native list + preferences; choose folder; ask toggle; render unsupported honestly. Live: attachment appears, folder/ask round-trip. |
| Profiles | `profiles_get` and create/switch/rename/delete/avatar unrouted; page empty | `SelectableProfileService` / `nsIToolkitProfileService` | Add `Profiles.sys.mjs`, routes, `profiles-changed`; dev `-profile` must report the running profile honestly. Live: rows, create/rename/delete; switch is a relaunch path and must be tested. |

## Lane 5 — Time and Performance

| Setting | Current state | Native owner | Change |
|---|---|---|---|
| Count time / retention | stored; `Time.sys.mjs` returns empty buckets; no tracker | Astra Rust `astra-time`/`astra-store` | Drive `time_start/time_end/time_report` from tab activity; prune by `time.retention`. Live: 60s fixture → site row; retention prunes. |
| Focus rounds | in-memory clock; `shut` empty; no history | Astra Rust focus + store | Persist rounds, real `shut`, blocked-site hook. Live: blocked navigation + history row after restart. |
| Sleep inactive tabs | pref written; Firefox only unloads on memory pressure and reads the pref at module load; no timer | `gBrowser.discardBrowser`, `TabUnloader`, `nsITabUnloader` | Host sleep driver reading `performance.sleep/after/memory/exceptions` (`sleeping::select_for_sleep`), route discard/wakeup. Live: 10 tabs → discard + PSS drop; exception stays; wake restores. |

## Lane 6 — Material, Zoom, Home

| Setting | Current state | Native owner | Change |
|---|---|---|---|
| Window material | `ui.material` has no consumer; `System.uiInfo` returns `none`; no `material.*` emitter | Platform widget (Windows mica, macOS vibrancy; Linux opaque) | Apply the choice to the window where the platform supports it, emit `material.<tier>`, read `ui.material`, hide unsupported options. Live: chosen tier, root `data-material`, and `uiInfo` agree. |
| Zoom levels reset | `zoom_call` unrouted; Astra zoom never writes the content pref | `nsIContentPrefService2` `getByName/removeByDomainAndName/removeByName`, `browser.content.full-zoom` | Add Zoom host module + route; persist site zoom; reset one/all; private never writes. Live: zoom a fixture, see/remove the row. |
| Home page | `tabs.home` has no reader; `nav.home` key is registered but has no executor; native `goHome` still exists | `BrowserCommands.home()` / `HomePage.get` | Add `nav.home` executor, read `tabs.home` with homepage fallback, disable the native `goHome`, add a caller. Live: Alt+Home lands on the saved URL. |
| Density | `data-density` applied; only a few tokens change | `browser.uidensity` + Astra tokens | Extend compact tokens to tab rows, sidebar/dock/rail and controls. Live: measured heights change. |

## Verification per lane

1. Contract/unit tests for the new route/module.
2. `python3 tools/marionette-probe/<lane>-probe.py` against the packaged dev
   build, headed; the probe is committed.
3. Integration branch: rebuild chrome once, `forge overlay`, `build --faster`,
   run `settings-audit-probe.py`, `settings-native-probe.py`,
   `settings-restart-probe.py`, `wire_coverage.mjs`, `state-check`,
   `brand-lint`, `forge lint`.
4. A lane is done only when the owner’s exact complaint is reproduced as
   failing, then observed passing in the live build.

## Already closed

- All browser settings persist; Astra-only values live under
  `astra.settings.*` and survive restart.
- Appearance light/dark/system applies immediately; keyboard theme commands
  persist.
- Startup mode/pages persist and the startup page opens after relaunch
  (`mozilla.cfg` no longer overwrites the choice).
- `run-dev.sh` no longer forces `about:blank`.
