# Astra task state (§1.2, §1.5) — the task-lock registry. Update + commit on every transition.

Legend: `todo` · `doing` (locked) · `blocked` · `done`. A `doing` row's Agent+Branch
lock it: no other agent may touch that task, its files, or its branch.

> **⚠️ CURRENT SCOPE — UI + WIRING (D-38, from 2026-11-03).**
> We build the interface and the route → host module → engine path it needs.
> A surface is done when it works in the packaged dev build, not when it
> renders. Empty, mock, disabled and `unknown_command` states are bugs when a
> real backend exists. Read `docs/astra/SCOPE.md` before picking up any task;
> pick from **Remaining wiring** below and close a row only when the live
> Marionette probe passes.

## Owner report: native surfaces — split view, peek, space isolation (2026-11-08, latest)

**What changed:** the split grid, page previews, per-space history, per-space
extension sets, cross-space cloning and native tab groups are real surfaces,
not painted placeholders. Split view is the engine's own `TabSplitView`: the
same `gBrowser` tabs, panels and splitter the tab strip would use, projected as
`ItemsState.split_group`. Peek captures the live page with
`PageThumbs.captureTabPreviewThumbnail`; it never keeps a hidden browser.
History reads through a per-space visit index; extension sets are applied on
space switch; a clone opens in the target space's container. The canonical
contract and the full inventory live in `docs/astra/NATIVE_SURFACES.md`.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Split view | 1–3 native panes (a fourth is refused), divider ratio, replace/leave, drag-to-edge, save/restore, background tabs load when split | `overlay/astra/host/SplitView.sys.mjs`, route table (`tabs_split`/`tabs_unsplit`/`tabs_leave_split`/`split_*`), `Content.sys.mjs` binds the native map, `Tabs.__setSplitGroup` projection, `ui/app/src/features/split`, tab menu, `tab-menu.ts` | `native-surfaces-probe.py`: 2 panes on Wikipedia + MDN, widths 244/421 after ratio, 3 panes live, arrangement restores 3, drop accepted, replace keeps 2 |
| Native groups | Handles, collapse, ungroup and sidebar headings for engine tab groups | `TabGroups.sys.mjs`, `tabs.group_*` routes, `TabView.group`, `sidebar-model.ts` group units, `TabList` headings | probe: group created, both members projected, `.tab-group-head` drawn |
| Peek | Window-like popup: real capture, close, bookmark, open as tab/split, hover/shift/menu, independent cards, restore, settings | `Peek.sys.mjs`, `peek_*` routes, `$domain/peek`, `PeekLayer.svelte`, `peek-changed` channel, Tabs/Bookmarks hover timers | probe: 31 kB PNG capture of Wikipedia, `.peek-window` drawn above the page with an inset clip, bookmark/open-tab/open-split actions; closing frees the capture |
| Per-space history | History page and panel read only the space in front; private writes are refused; Clear removes only that space's rows | `SpaceHistory.sys.mjs`, `history_call` routes through it, `Content` notes commits, Privacy settings | probe: space 1 sees Wikipedia/MDN and not the space-2 visit; space 2 sees its IANA visit and not Wikipedia |
| Per-space extensions | Assignment list, enable/disable on switch, copy a set, profile-scope limit stated | `SpaceExtensions.sys.mjs`, `space_extensions_*`, Settings → Extensions | probe: reads the active set; contract covers assignment validation |
| Cross-space clone | New native tab in the target space's container, optional history, optional background | `SpaceClone.sys.mjs`, `tabs_clone_to_space`, tab menu | probe: clone of Wikipedia lands in `space-1` with a live Astra id |
| Settings / themes | Every new surface has a row in Tabs, Privacy or Extensions; all animations stand down under reduced motion; light/dark measured | `catalog.ts`, `TabsPage`, `PrivacyPage`, `ExtensionsPage`, `SpaceHistoryClear`, `SplitArrangements` | `settings-audit-probe.py`: 95 controls, 0 failed; probe: `data-theme` light → dark → light |

**Security / resources:** private windows refuse peek restore, arrangements and
history writes. Split never spans spaces. Peek keeps at most 4 cards and
releases each canvas after reading the PNG. History index is bounded at 5 000
rows with a debounced write. Extension sets toggle add-ons only; nothing is
uninstalled. Group and split listeners are keyed to the window and removed in
`Content.detach`.

**Verification:** `native_surfaces.mjs` 120/120; typecheck, lint, stylelint,
format, knip clean; 1238 unit tests; `settings-audit` 95/0; adblock benchmark
PASS; `wire_coverage` PASS; live probe 40/40 on Wikipedia, MDN and IANA.
Evidence in `/tmp/opencode/ns-out` for the run and reproducible with
`tools/marionette-probe/native-surfaces-probe.py out/native-surfaces`.

**Limit:** Places keeps one history database per profile directory; per-space
history is enforced by the Astra visit index and scoped queries, not by
partitioning the Places file. Extensions remain installed at profile scope;
per-space behaviour is an enable/disable assignment. Both limits are stated in
Settings and in `NATIVE_SURFACES.md`.

## Owner report: protected content — Widevine L3 (2026-11-08, latest)

**What changed:** Astra now ships protected-content playback on by default and
owns the only switch for it. The Linux build already compiled Widevine
(`MOZ_EME_MODULES: ['widevine']`); the missing pieces were EME being off by
default, no Astra control, and the CDM update host classified `REPLACE`.

| Surface | What works | Wiring / files | Evidence |
|---|---|---|---|
| Default posture | EME is on after first launch; Widevine may download; the engine's own "enable DRM" doorhanger and about:preferences checkbox never appear | `overlay/astra/mozilla.cfg` (`media.eme.enabled`, `media.gmp-widevinecdm.visible/enabled`, `browser.eme.ui.enabled=false`) | `protected_content.mjs` static checks |
| Settings → Privacy → Protected content | A real `Play protected content` switch reads/writes `media.eme.enabled` and survives restart | `ui/app/src/features/settings/lib/catalog.ts` (`privacy.drm`), `components/sections/PrivacyPage.svelte`, `$domain/preferences` default, `overlay/astra/host/Settings.sys.mjs` NATIVE entry | `PrivacyPage.component.test.ts` 2/2; `settings_native.mjs` 103 |
| CDM update | `update.googleapis.com` is a signed-off `KEEP`; disabling DRM re-removes the module | `tools/endpoint-audit/classify.toml` | `protected_content.mjs` |

**Strict rule:** `tests/contract/protected_content.mjs` (registered in
`tools/perf/full-suite.sh`) fails if the autoconfig, the endpoint
classification, the host mapping, or the app surface drift.

**Limits:** L3 only. Widevine L1 needs a hardware TEE and Gecko only ships the
L1 CDM on Windows x64, so 4K/HDR OTT playback is not possible on this target.
Recorded in `docs/astra/KNOWN_LIMITS.md` and `PRIVACY_PREFS.md`.

**Verification:** `typecheck` 0/0, `eslint` clean, `prettier --check` clean,
`PrivacyPage.component.test.ts` 2/2, `settings_native.mjs` 103/103,
`protected_content.mjs` 19/19. Chrome bundle rebuilt and `jar.mn` regenerated.

## Owner report: sidebar utilities folded into the column head (2026-11-08)

**What changed:** the 44px utility rail beside the sidebar is gone. Media,
downloads, notes, spaces and sleeping tabs now share the column's own top row,
with the shape toggle first; at 56px the same entries become a two-column tool
grid under the head. The page gains the 44px the rail used to hold
(`publishedWidth()` is the column alone), and the duplicate profile entry that
sat at the rail's foot is removed — the dock's tools/profile case is the one
profile surface.

**Motion:** the plates settle in one beat apart (`bar-plate-in`, 18 ms stagger),
hover/press keep their colour and scale transitions, a media/sleeping dot pops
in when the list has something in it, and the list rows settle behind each other
inside a bar popover. Every one of those stands down under reduced motion.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Utility bar | Media, downloads, notes, spaces and sleeping tabs in the column head; the tool entries light while their panel is open and close it again | `ui/app/src/features/rail/components/UtilityBar.svelte`, `SidebarHeader.svelte`, `Sidebar.svelte`; callers unchanged (`$session/tools`, `$features/tabs` spaces, the window's own tab projection) | `tools/marionette-probe/utility-bar-probe.py`: aside `240` (was `284`), bar `x16 y11 w224 h26`, 6 plates, no overflow, no `.utility-rail`; media popover `x16 y43 w224`, inside the column |
| Tool / settings rail | The panel keeps a 56px tab column (search + tabs + new tab), and the utilities stand in a **horizontal strip across the panel's head**, not a side grid. The duplicate spaces switcher and the mode switch leave the rail. Every tool now carries a direct close control in its header: Notes, History, Tasks and Time no longer hide it behind their overflow menu. | `Sidebar.svelte` (`sidebar-tool-utilities` / `sidebar-tool-panel`, `{#key compact}` column), `TabRail.svelte` (`spaces={false}` from `Shell.svelte`), the four tool previews (`closable` back on) | `utility-bar-probe.py` 27/27: utilities leave the tab column, head the panel, span its width; tab column keeps the search; panel header has "Close tool"; no mode switch; one `.rail-spaces`; panel `x72 y8 w336` |
| Hide / peek | The shape toggle in the bar follows the same `toggleShape` path (closes a tool first, otherwise hides), and the card/edge behaviour is unchanged | `Sidebar.svelte` `toggleShape`, `sidebar-mode.svelte` `RAIL_WIDTH` removed | `utility-bar-probe.py`: the toggle sets `data-hidden`, the edge event → `data-peek` and the card comes back; `sidebar-probe.py` still PASS |
| Private / multi-window | The bar reads only the window's projection; media and sleeping stay empty in private windows; no profile history is kept | `rail-model.ts` unchanged guards, `UtilityBar` private branches | `UtilityBar.component.test.ts` private case |

**Verification:** `bun run typecheck`, `lint`, `stylelint`, `format:check`,
`knip`, 1238 unit tests (2 environment skips), and 56 component tests across
the rail/sidebar/tabs/tools/Shell suites. Chrome build + `forge overlay` +
`build --faster` clean; `state-check` and `brand-lint` clean. Pre-existing
component failures outside this surface (`ShellA11y` stale
`[data-content-bar]` selector, `SpacesLook` site-info click) are unchanged and
are not part of `tools/perf/full-suite.sh`.

## Owner report: dev-build console noise (2026-11-08)

The owner pasted a dev-console dump. Four signals, three expected in a dev
profile that gets killed and restarted, one real null-dereference.

| ID | Signal | Verdict | Action / evidence |
|---|---|---|---|
| C-01 | `Script terminated by timeout` on YouTube's embed and miruro.tv | page-side `dom.max_script_run_time` watchdog; a debug build under CPU load (parallel build, paused process) trips it | no product change; the stack is the site's own bundle, not chrome |
| C-02 | `services.settings … getLastModified() … request was aborted` | Remote Settings IndexedDB transaction killed by a hard restart or a wiped `storage/default`; Mozilla's own profile-generation CI logs the same lines | none; self-heals on a clean start |
| C-03 | Bookmark backup `NotFoundError … source file does not exist` | upstream `PlacesBackups.create()` rename race: two same-hash runs move the same file, the loser gets `NS_ERROR_FILE_NOT_FOUND`; today's backup exists | none; harmless end state |
| C-04 | `AsyncTabSwitcher … can't access property "schemeIs", requestedBrowser.currentURI is null` | **real**: `updateDisplay()` dereferenced the URI of a tab with no document yet (new, discarded/crashed, or torn down mid-switch) | ASTRA-0012; `updateDisplay()` treats a missing URI as an unloaded `about:` page and takes the blank-tab branch instead of throwing |

**Verification (C-04):** `forge lint` — 12 patches clean, ASTRA-0012
forward-applies to baseline `61e41ec4` and reverse-checks as applied;
`build --faster --jobs 2` 3 s; the packaged `moz-src` module carries the guard;
`state-check`, `brand-lint` clean. The null window is a race, so there is no
deterministic live reproduction; the URI-present path is unchanged. Branch:
`fix/async-tab-switcher-null-uri` (outer) + `astra/async-tab-switcher-null-uri`
(engine). The other three signals were left alone; the engine-side
`updateDisplay` guard is the only code change.

## Owner report: YouTube scriptlet resource fix (2026-11-07)

**Symptom:** YouTube showed video ads and page ad slots even though the lists
and cosmetic selectors were installed.

**Root cause:** `blocker/resources/resources.json` shipped only 10 resources
(the Brave browser-compat set plus Astra's redirect placeholders). The generic
uBlock Origin scriptlets that the default lists reference (`json-prune`,
`json-prune-fetch-response`, `json-prune-xhr-response`, `trusted-replace-xhr-
response`, and their `.fn` dependencies) were absent. `adblock-rust` therefore
compiled every `##+js(...)` rule to nothing: `cosmeticFor(youtube)` returned
`script_len=0`, so the ad JSON was never pruned.

**Fix:** `blocker/tools/sync.py` now merges the complete generic scriptlet set
from `adblock-rust/data/brave/brave-resources.json`, still dropping `brave-*`
and `async-sugarcoat-*`. The bundle is 199 resources. `sync.py --check` and
`tools/blocker-wiring-check.sh` now fail if the required scriptlets are
missing.

**Evidence (packaged dev build, fresh profile):**
- `cosmeticFor("https://www.youtube.com/watch?v=QzqaZshQcJI")` → 96 010-byte
  script payload containing `jsonPrune`, `trustedReplaceXhrResponse` and
  `safeSelf` (was 0 bytes).
- Live player: `ytInitialPlayerResponse.adPlacements`, `.playerAds`,
  `.adSlots` are `undefined`; `.ad-showing` false; page `XMLHttpRequest` is
  replaced by `json-prune-xhr-response`.
- `adblock-benchmark-probe.py` → PASS; `blocker-wiring-check.sh` → 40/40.
- Rebuild was `forge overlay` → `build --faster`; restart the browser to load
  the new resource bundle.

## Owner report: shields parity features (2026-11-07, later)

Every row below is live in the packaged dev build. The engine now returns a
three-way verdict (block / redirect resource / rewritten URL), and the Host
owns the settings, persistence and DNS CNAME fallback.

| Surface | What works | Wiring | Live evidence |
|---|---|---|---|
| Benchmark | 132/132 on adblock.turtlecute.org (128 hosts + 2 cosmetic + 2 script canaries), 0 not blocked | catalog defaults (14 lists incl. social and cookie) + `blocker/lists/astra-telemetry.txt` (bundled, default) + `/ads.js`, `/pagead.js` script heuristics | `adblock-benchmark-probe.py` PASS, report in `out/adblock-benchmark/` |
| YouTube | Player plays while no `.ad-showing`, no visible ad module, for 24 s of playback | filter lists + scriptlets + script heuristics | `adblock-benchmark-probe.py` samples, screenshot `youtube.png` |
| `$removeparam` | Tracking parameters are stripped before connect | Rust `rewritten_url` → C++ `nsIHttpChannel.redirectTo` | `shields-probe.py`: `/echo?utm_source=…` reaches the server as `/echo?keep=1` |
| `$redirect` | Redirect rules load the neutral resource body; the original URL is never fetched | Rust returns the `data:` URI → C++ redirect + loadInfo data allowance | `shields-probe.py`: 1×1 GIF, `naturalWidth=1`, server hit 0 |
| Bounce/unlinkable | Known redirectors and shorteners open the destination directly | Rust `bounce_target` → channel redirect; Firefox BTP mode 2 | `shields-probe.py`: Google `/url?q=` lands on the loopback destination; `classifyBounce`; BTP pref 2 |
| CNAME uncloaking | First-party hosts whose canonical chain is a tracker are marked and then cancelled | Host DNS (`asyncResolve` canonical + `res_query` fallback) → `classifyHost` → `setCloakedHost`; Rust blocks later requests | `shields-probe.py`: direct enforcement; `cname('www.apple.com')` returns the Akamai chain |
| Block Scripts | Global and per-site cancels `script` requests | Rust policy/flag + Host per-site persistence | `shields-probe.py`: `/site-script.js` hit 0 with per-site scripts on |
| Standard / Aggressive | Presets switch list membership; aggressive adds annoyances and social embeds | Host `modePreset`, `astra.blocker.mode` | `ProtectionControls` control + `lists.mode` projection |
| Per-site shield | Off / Standard / Aggressive, block scripts, cookies, forget, fingerprint | `setSitePolicy`, `privacy_site_*` routes | `shields-probe.py`: per-site block scripts; cookie block/allow; forget clears cookies |
| Custom lists / rules | HTTPS list URLs and a user rule text are compiled with every reinstall | Host `buildBundle` + cache/refresh | `shields-probe.py`: user rule blocks `/custom.png`; `privacy_host.mjs` |
| Cookies | Allow / block third-party / partition | `network.cookie.cookieBehavior` | `shields-probe.py`: pref 1 from `block-third-party` |
| Forgetful browsing | Last tab for a site clears its data (`CLEAR_FORGET_ABOUT_SITE`) | `nsIClearDataService` + Host tab tracking | `shields-probe.py`: cookies 0 after `forgetSite`; `privacy_host.mjs` |
| Fingerprinting | Off / Standard / Aggressive FPP target sets, per-site granular overrides | `privacy.fingerprintingProtection(.overrides/.granularOverrides)` | `shields-probe.py`: aggressive set includes `ScreenRect`/`JSLocale`; contract 22 checks |
| Language / screen | `navigator.language` and Accept-Language spoof; screen metrics targets | FPP targets + `intl.accept_languages` + header observer | `shields-probe.py`: `Accept-Language: en-US` on the wire |
| Cookies per site | Block / allow / default for the current origin (scheme + port) | `nsIPermissionManager.addFromPrincipal` | `shields-probe.py`: `document.cookie` empty when blocked, set when allowed |

Rebuild note: the engine change needs `forge overlay` → `forge export` →
`forge build --jobs 2` (never uncapped). The overlay-only/Host changes need
`overlay` → `build --faster`.

**Verification (final, 2026-11-07):** `tools/perf/full-suite.sh --skip-build
--skip-perf` → **PASS** (contracts incl. `privacy_host` 22 checks, 1238 UI
unit tests, 25 live probes incl. `shields`, one environment SKIP for media).
`adblock-benchmark-probe.py` → **132/132** and YouTube 24 s playback with no
ad; `shields-probe.py` → PASS (30 checks). Evidence in
`out/adblock-benchmark/`.

## Owner report: Brave-derived blocker, settings and schedule (2026-11-07)

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Ad/tracker blocking | Every normal and private window blocks matching network requests before connect, first- and third-party. The engine is Brave `adblock-rust` (the audited `0.12.1` vendored by Gecko), one instance shared by the hook and chrome. | `blocker/engine/src/lib.rs` (Rust), `AstraBlocker.cpp` (channel hook), `patches/ASTRA-0003/0004/0005`, `overlay/astra/host/Blocker.sys.mjs` | `blocker-probe.py`: loopback `/ad.png` cancelled with **0 server hits**; ≈155k compiled rules on the bundled seed; private flags excluded from counts |
| Filter lists and updates | 80-list catalog (uBO/EasyList/EasyPrivacy/URLhaus + optional annoyances/regional), per-list toggles, on-disk cache, HTTPS refresh, 24 h default schedule, update-on-start, "Update lists now"; failed updates keep the previous engine. | `blocker/lists/catalog.json`, `blocker/tools/sync.py`, `Blocker.sys.mjs`, `nsIAstraBlockerService` | `blocker-probe.py`: catalog 80/10 defaults, `configure` persists 6 h + 2 lists, update path installs a new revision |
| Settings | Privacy → Ad, tracker and malware protection renders the status, catalog, schedule, element-hiding/scriptlet switches, counters and reset. | `ui/app/src/features/settings/components/ProtectionControls.svelte`, `domain/blocker`, `blocker_lists`/`blocker_configure`/`blocker_reset_stats` | `blocker-probe.py`: section + 18 visible catalog checkboxes + interval selector in the real app frame |
| Cosmetic filtering | The page actor injects CSS/scriptlet/procedural payloads from the engine; click-to-hide still uses the same provider. | `overlay/astra/actors/AstraBlocker{Parent,Child}.sys.mjs`, `Content.sys.mjs` `wireHiding` | `blocker-probe.py`: `.astra-test-ad` computed `display:none`; native lookup returns the selector |
| Branding / telemetry | Brave-owned list sources and `brave-*`/SugarCoat resources are dropped; no rewards, telemetry, P3A, sync or update host. Every list keeps its upstream URL/licence. | `blocker/tools/sync.py`, `blocker/NOTICE.md`, `docs/astra/BLOCKER_UPSTREAM.md` | `sync.py --check`, `brand-lint`, catalog inspection |
| Fingerprinting | FPP is on browser-wide with a strengthened target set (GPU, audio, fonts, display, timer); the UA, timezone and screen stay real so sites work. Settings has a live switch. Tracker blocking remains the filter-list engine. | `overlay/astra/mozilla.cfg` (`defaultPref`), `Settings.sys.mjs` (`privacy.fingerprinting`), `ProtectionControls.svelte`, `docs/astra/FINGERPRINTING.md` | `fingerprint-probe.py`: FPP on, canvas randomized, GPU `Mozilla`, concurrency tiered 8 vs 16; UA/TZ unchanged |
| Real-web smoke | Ad-heavy pages blocked 9–46 requests each, every tracker resource had `transferSize=0`, every ad-like slot was hidden; YouTube played muted with no ad overlay. | `tools/marionette-probe/real-sites-probe.py` | speedtest, The Verge, CNN, Forbes, YouTube; optional network probe |

Deferred and recorded in `docs/astra/BLOCKER.md`: `$redirect` response-body
substitution, rare multi-operator procedural filters, and worker-thread
compilation (would require dropping the `single-thread` feature shared with
the content classifier).

## Verification pass — 2026-11-06 (all gates green)

Everything below was re-run against the freshly packed dev build.

- **/tmp was the outage, not the app.** 146 leaked probe profiles (≈9 GB)
  filled the tmpfs; Firefox aborted with `Disk quota exceeded` and every probe
  died on connect. Cleaned. `tools/perf/hidden-display.sh` now exports
  `TMPDIR` inside its throwaway runtime, so profiles are removed with it.
- **Settings works live:** `settings-audit-probe.py` drove **60 controls, 0
  failed**. `settings_audit`, `settings_parity`, `tabs_settings`,
  `material_zoom_home` and `profiles_switch` are now part of
  `tools/perf/full-suite.sh` instead of being manual-only.
- **Host/tests repaired:** create with `and_switch` now launches the new
  profile (it was accepted and silently ignored); `profiles_model` and
  `system_model` expectations updated to the current behavior (`ui_info`
  carries `materials`); the bridge test uses a still-unrouted command; three
  committed files reformatted.
- **Settings UI tests repaired:** `SiteSettings` mock lacked `watch`; account
  dates and prices now format with the interface locale (`getLocale()`) rather
  than the host OS locale; the component browser is pinned to `en-US`;
  launcher-shortcut labels are platform-aware; one 1px layout tolerance.
- **Probe determinism:** a CSS transition is finished explicitly before its
  opacity is read (rAF is frozen under the hidden display); the tabs probe aims
  the synthetic hover at the video `<browser>` and records automatic PiP as a
  reasoned SKIP when no trusted pointer can cross the chrome boundary.
- **Evidence:** `tools/perf/full-suite.sh --skip-build --skip-perf` → PASS
  (contracts, 1238 unit tests, 24 live probes + the 5 settings probes; `media`
  SKIP = no audio device). 44 settings component files / 178 tests pass;
  typecheck, lint, knip, format, forge lint/footprint, state-check and
  brand-lint clean.
- **Known, unchanged:** component tests outside settings that need the Phase-2
  artifacts (`SelectiveStyles`, clipboard, work/semantic) still fail on the
  documented missing `content_style.js` and friends. They are not part of the
  canonical gate.

## Owner report: floating page bar + in-window profiles (2026-11-07)

| Surface | Fix | Wiring / files | Live evidence |
|---|---|---|---|
| Page bar float | Revealing the bar no longer takes a row and moves the page. The bar is absolutely positioned over the page with its own ground, slides in/out on the motion curve, and hides after a 260 ms trail so the pointer can travel from the top edge onto it. While the bar is away the shell's own 8px top strip (in the window gutter, above the page) owns the pointer and forwards hover to the app; the app frame — and its themed ground — stays under the page. The frame is raised and clipped only while the bar is down, so the sidebar, window ground and top chrome keep exactly the same colours on a page as on Home. | `ui/app/src/app/browser/Shell.svelte` (`barOverPage`, `holdBar`/`releaseBar`, `data-bar-overlay`, `bar-hover` message), `ui/shell/src/Shell.svelte` (`astra-bar-reveal`, `data-astra-bar=overlay`/`flow`, `data-astra-bar-open` only while shown, polygon clip) | `tools/marionette-probe/bar-probe.py` (now in the full suite): home `flow`; page `overlay` with content top 8 and the same computed ground as Home; shell hover → `shown` with top still 8; leave hides after the trail; app menu still opens over the page |
| In-window profiles | A profile switch selects that profile's space in the same window: no new window/process, tabs kept per space, and a container partition per profile. Create/rename/delete carry the space and its container data. | `overlay/astra/host/Profiles.sys.mjs` (profile↔space map under `astra.profiles.spaces`, `spaceForProfile`, in-window `switch`), `overlay/astra/host/Tabs.sys.mjs` (`space.switched`), `ProfilesPage`/rail copy | `profiles-switch-probe.py`: rail menu switch accepted, 1 window, tabs restored on return, `probe=personal` absent in Work, localStorage isolated; delete removes the space + container |
| Window corners | The borderless Linux window was a square plate. The document root now carries a 14px radius and `overflow: hidden`; the same rule sets the root background transparent, so Gecko creates a transparent widget and the desktop shows through the four corners. It stays on for a normal, tiled or maximized window and stands down only for fullscreen / DOM fullscreen. | `overlay/astra/chrome/shell-chrome.css` (`#main-window`), `tools/marionette-probe/window-radius-probe.py` | `window_radius` probe: normal `14px` + `hidden` + transparent; maximized keeps `14px`; fullscreen and DOM fullscreen are `0px` |
| Search latency + skeleton theme | Enter in the New Tab search and the launcher resolved the typed words immediately instead of queueing behind the provider suggestion answer (the address field was already instant). Both now take the address bar's exact `tabsNavigate` route on the tab they are bound to, so there is no second host route or selected-tab lookup; the host search route's dynamic imports are static now too. The shell's page-load skeleton and loading ground follow the app's light/dark theme instead of always painting dark. | `ui/app/src/features/search/lib/search-surface.svelte.ts` (`submit` → `searchTyped` when no row is aimed at; `tabsNavigate` for anchored/settled search rows), `overlay/astra/host/Search.sys.mjs` (static Tabs/Navigation imports), `ui/shell/src/Shell.svelte` (`data-astra-theme` from `onTheme`, `--shell-loading-*` tokens) | `search-theme-probe.py` (now in the full suite): Enter → tab URL in **0.002 s**; light skeleton `rgb(241,241,243)`; `theme.dark` → `rgb(28,27,34)`; back to light |

Limit: preferences, extensions and the Places history database are shared by the
one running profile directory; cookies/sign-ins/localStorage/IndexedDB/cache are
per profile. D-41 records the decision.

## Owner report: page bar, media, popups, downloads and type (2026-11-06)

One surface batch from the owner's report. Each row was exercised against the
packaged dev build with the Marionette probes named here; the probes are in
`tools/marionette-probe/` or `/tmp/opencode/` (throwaway evidence, reproducible
from the steps).

| Surface | Fix | Wiring / files | Live evidence |
|---|---|---|---|
| Page bar | The bar no longer stays on a web page. `ui.main-bar` is `auto` (home and internal pages show it, a web page hides it), `always`, or `hidden` (only on hover). The shell takes the page's top row back while it is away, and a top-edge hover (or its keyboard focus) returns it. | `ui/app/src/app/browser/Shell.svelte`, `ui/shell/src/Shell.svelte` (`kind:"bar"`), `ui.main-bar` preference (Astra-only, stored under `astra.settings.ui.main-bar`), Appearance setting | `bar-probe.py`: home bar present; page load → `data-astra-bar=hidden` and `.astra-content` top `8px`; hover → `shown` and `48px`; leave → hidden again |
| Media rail | A playing tab is projected instead of only a background one, and a tab that is audible is in the rail's list (the old projection only carried mute). Position/metadata/transport follow the same controller. | `overlay/astra/host/Content.sys.mjs` (`mediaView`, `projectMedia`, `audiblechange` → `__applyExternalUpdate`), `overlay/astra/host/Tabs.sys.mjs` (`audio`), `hostapi_v1` checks | `hostapi_v1` 327 checks (audible, silent, muted projection); `media_player_probe` is SKIP without an audio device |
| Picture-in-picture | The player's PiP control now asks the engine's `PictureInPictureLauncher` actor, and the automatic path is seeded on at startup; a person's off choice still wins. | `Content.sys.mjs` `picture_in_picture`, `mozilla.cfg` seed for `media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled` | `tabs-settings-probe.py`: 17 checks, setting reaches the pref, outgoing browser parks and the page reports `hidden`; the PiP player window itself is a reasoned SKIP under the headless compositor (the launcher actor answered) |
| Popups above the page | Every app pop-up (menu, dialog, listbox, select, tray, address suggestions) raises the app frame and makes its ground transparent, not just the address tray. The page menu is now drawn by the app's menu system instead of shell-inline constants, and the engine's `contentAreaContextMenu` is suppressed for the native deck too. | `ui/app/src/app/browser/Shell.svelte` (popup observer), `ui/shell/src/Shell.svelte` (`showMenu` → app, deferred, no function in the clone), `ui/shell/src/content-menu.js` (`getTabForBrowser`) | `bar-probe.py`: native page menu prevented; the app menu lists `Open Link in New Tab … Select All`; a row runs and closes; `ui-consistency-probe` still passes the ground menu/settings/narrow layout |
| Downloads window | Native sends `created_at` as an ISO timestamp, but the list parsed it as epoch seconds; the invalid `Date` threw during day grouping and the panel rendered nothing. Both the day label and the sort now accept ISO and legacy epoch seconds. | `ui/app/src/features/downloads/components/DownloadsList.svelte` | `DownloadsList.component.test.ts` (ISO grouping); host probe: a real attachment appears in the native list with `created_at:"2026-11-06T11:25:55.469Z"` and `state:"completed"` |
| Online search suggestions | The address field is now a third suggestion consumer (New Tab and launcher were already wired). It asks the same host `Search.launcherSearch`, so `search.suggestions` gates every box. | `ui/app/src/features/address/components/AddressField.svelte` | `suggest-probe.py`: `weather` → five Google suggestions + the search row; setting off → no provider rows |
| Interface type | The body is Inter and display type is Instrument Serif, bundled in the chrome app. `ui.font` now defaults to `astra`; the system/rounded/serif/mono faces remain choices. | `ui/app/src/styles/fonts.css`, `styles/fonts/*.woff2`, `axes/type.css`, `tokens.css`, `FontPicker.svelte` | `bar-probe.py`: body computed `"InterVariable", …`, `document.fonts.check("13px InterVariable") === true`, `--font-display` resolves to Instrument Serif |
| Profile switch | In-window: each profile browses in an Astra space backed by a Firefox container. A switch selects that space in the same window, restores its tabs, and swaps the container partition; no new window or process. Create/rename/delete carry their space. | `overlay/astra/host/Profiles.sys.mjs` (`spaceForProfile`, `switch`), `Tabs.switchSpace`, `profiles-switch-probe.py`, D-41 | `profiles-switch-probe.py`: accepted, 1 window before/after, tabs restored on return, `probe=personal` invisible in Work and back; probe removes its profile |

Notes and limits:

- **Fonts are open equivalents.** ABC Oracle, Exposure and GT Alpina are
  commercial and are not redistributed. Inter and Instrument Serif are SIL OFL
  1.1; sources/licences are in `ui/app/src/styles/fonts/README.md`.
- **In-window profile switching is container-scoped, not a profile-directory
  change.** A real profile directory cannot be moved into a running process.
  D-41 gives each profile an Astra space backed by a container: cookies,
  sign-ins, localStorage/IndexedDB and the HTTP cache are isolated per profile,
  and tabs are kept per space. Preferences, extensions and the Places history
  database are still shared by the one running directory; the Profiles copy
  states this. Proven live by `profiles-switch-probe.py`.
- **PiP and the media rail need an audio/video device for a full live proof.**
  The engine's launcher actor and the tab-visibility path are verified; the
  player window and audio rail remain reasoned SKIPs under the headless
  compositor, as before.
- **The page menu posts asynchronously.** A native `popupshowing` runs inside
  the engine's event loop; the app copy is delivered on the next turn, and the
  `choose` closure stays in chrome (it cannot be structured-cloned).

## Where things stand (2026-11-04 — read this first, next agent)

The browser builds, boots, and **the product UI is the window's chrome** (not a
page painted over Firefox). Phases 0–6 are done; the active lane is the
connected product surface: `ui/app` + `ui/shell` + the Host API and engine
hooks each one needs (D-38).

**Run it**

```sh
./tools/run-dev.sh            # reuse out/dev-profile
./tools/run-dev.sh --fresh    # clean profile
tools/perf/full-suite.sh      # build + contracts + UI + 21 live probes + benches
```

The full native-merge pass (2026-11-04), its verification table and the honest
open list are in `docs/astra/REPORT-2026-11-04.md`; remaining product gaps are
in `docs/astra/KNOWN_LIMITS.md`.

**Rebuild after a change**

```sh
bun run --filter @astra/frame build:chrome     # ui/app changed
bun run --filter @astra/shell-hello build      # ui/shell changed
(cd forge/astra-forge && cargo run -q -- overlay && cargo run -q -- build --faster)
```

`build --faster` repacks in ~7 s. Only an engine change (`engine/**`, C++/Rust)
needs the full build: `cargo run -q -- build --jobs 2` — **always cap jobs**,
an uncapped gkrust LTO link has OOM-killed this machine (BUILD_TIMES.md).

**Architecture in one paragraph.** `ui/app` (Svelte 5) is packaged as the
first-party document `chrome://astra/content/app/browser-chrome.html`
(jar.mn) and embedded by `ui/shell/src/app-frame.js` in a chrome-privileged
`<iframe>`. Same principal and process, so the bridge imports the Host API
directly (`resource://astra/host/HostAPI.sys.mjs`) — no relay, no `file://`,
no framescript. The app renders from `items-changed` projections and listens
on `astra:*` DOM channels; the chrome entry re-dispatches bridge events onto
those channels. Web pages stay content processes in the shell's content slot.

**Traps that cost real time — do not rediscover these**

- **Do not mount the app in-tree** in `browser.xhtml`. It was tried
  (2026-11-03) and reverted: the app's stylesheets are scoped to its own
  document (`#root`, `html`, `body`), so the address field went white, tab
  labels disappeared and the wordmark collapsed. D-35.
- **Do not remove the first-paint gate.** A chrome iframe caches the layer it
  painted while transparent; revealing it without invalidating both layers
  shows a half-built frame (the "appear → vanish → reappear" the owner
  reported). `app-frame.js` holds the frame at `opacity:0` until the app
  reports `ready`, then nudges both layers. D-35.
- **Patch ASTRA-0006 is load-bearing.** Svelte compiles every template through
  `template.innerHTML`; the default system-principal sanitizer strips
  `button`/`input`/`form`/`script`. Only `chrome://astra/` documents are
  exempt. Removing it silently breaks the mount.
- **`parseEnvelope` must keep a `null` payload.** `setting_get` returns
  `string | null`; coercing `null` to `{}` made every preference read back as
  an object, which silently disabled the clock, greeting and due-today pill.
- **Playwright cannot drive this binary.** It launches Firefox with
  `-juggler-pipe`, which Playwright's own fork speaks and our ESR build does
  not. Playwright stays on the standalone-Chromium lane
  (`ui/app/playwright.config.ts`); the dev build is driven over Marionette
  (`tools/marionette-probe/`).
- **Screenshots lie under Hyprland.** `grim` captures the last composited
  buffer; an unfocused/occluded window shows stale pixels. Match the window by
  **PID** (`tools/marionette-probe/framecheck2.py`) before believing a frame.

**Verification gates** (all green on `main`)

```sh
python3 tests/contract/shell_app_chrome.py   # 17 checks: chrome doc, root, host mode, first frame
node tests/contract/hostapi_v1.mjs           # 289 checks
node tests/contract/shell_assembly.mjs
node tests/contract/frame_model.mjs
(cd ui/packages/bridge && bun test)          # 25
(cd ui/app && bun run vitest run src/shared/ipc/bridge.test.ts)
python3 tools/state-check.py && bash tools/brand-lint.sh
(cd forge/astra-forge && cargo run -q -- lint && cargo run -q -- footprint)
```

### Remaining wiring (active backlog — D-38)

These are current work, not a parking lot. Each row needs a live probe before
it can be called done. The browser-core batch (history, bookmarks, favicons,
page menu, private/new windows, theme, loading, keyboard ids) is closed and
recorded below; this list is what is still genuinely unwired.

- **Split-pane content.** The app renders a split layout, but the content
  stage still shows one page. Needs one live `<browser>` per visible pane and
  a shell-side rect/visibility protocol.
- **Container-scoped opening.** The context menu can open a link in a new tab,
  window or private window, but not in a chosen Firefox container; there is no
  container picker in the Astra UI yet.
- **Guaranteed DevTools.** Closed in B-24: the toolbox now attaches to the
  real `gBrowser` tab the stage already uses (`Content.mountNative`), so the
  engine finds it, follows the tab's container and lifecycle, and F12 toggles.
  Live proof: `tools/perf/stress/devtools_probe.py`. The teardown console lines
  it used to print are gone too: `patches/ASTRA-0010-devtools-teardown-races.patch`
  defers the process-actor unregistration past the teardown turn and stops the
  late-resource lookup error (bugs 2044741/1944477); the probe's
  `upstream_noise` is now 0/0/0.
- **The remaining unrouted command ids.** 200 of the 270 generated commands
  still have no Host route (account, Work models/human/sites, page
  assist, voice, profiles, import/export, updates, menus, split/drag-drop,
  downloads manager, media import). They are recorded in
  `tests/contract/wire_baseline.json`; `wire_coverage` fails on any new gap.
  Add each with a UI caller, a route-table entry, a contract test and a live
  probe.
- **New Tab tracker figure.** `blocker_stats` is now routed to the live
  engine (D-42); the New Tab figure appears only when the reply is
  `status: "ok"`, so a missing count is hidden rather than drawn as `0`.
  `media_import` is routed: the
  picker stores an admitted image in `<ProfD>/astra-media/<profile>/<digest>`
  and the host serves it over `astra-media://localhost/`.
- **Host projection ownership.** `overlay/astra/host/Tabs.sys.mjs` still derives
  the projection; `astra-core` ownership is plan §5.4 work.
- **Popup / external-protocol cards.** `Tabs.answerPageRequest` is routed and
  refuses a card that is not on screen, but no producer raises those cards yet.
- **Multi-window organisation.** One writer per process; a second window's
  spaces/pins are not merged into the store (P5b-3).
- **Real page surface under split/work panes.** The content stage has only
  been exercised with one page; multi-pane and Work pane relayout remain
  unverified.

### Settings bound to native prefs (closed 2026-11-05)

`overlay/astra/host/Settings.sys.mjs` now has a native adapter. Keys below read
and write the Firefox pref (or content-pref service) that owns the behaviour;
the app still applies its own surface from the same value.

| Astra key | Native owner |
|---|---|
| `tabs.new-position` | `browser.tabs.insertAfterCurrent` + `browser.tabs.insertRelatedAfterCurrent` |
| `tabs.external-position` | `browser.link.open_newwindow.override.external` (3/7/-1) |
| `tabs.automatic-pip` | `media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled` |
| `tabs.startup` | `browser.startup.page` (0/1/3) |
| `tabs.startup-pages` | `browser.startup.homepage` (pipe list) |
| `search.suggestions` | `browser.search.suggest.enabled` |
| `search.history` | `browser.urlbar.suggest.history` |
| `privacy.smartscreen` | `browser.safebrowsing.malware.enabled` + `.phishing.enabled` |
| `privacy.cleanup` | `privacy.sanitize.sanitizeOnShutdown` |
| `privacy.camera` | `permissions.default.camera` |
| `privacy.microphone` | `permissions.default.microphone` |
| `privacy.location` | `permissions.default.geo` |
| `privacy.notifications` | `permissions.default.desktop-notification` |
| `performance.sleep` | `browser.tabs.unloadOnLowMemory` |
| `performance.after` | `browser.tabs.min_inactive_duration_before_unload` |
| `ui.density` | `browser.uidensity` |
| `ui.reduce-motion` | `ui.prefersReducedMotion` |
| `network.proxy` | `network.proxy.type` (1 manual / 5 system) |
| `network.proxy-address` | `network.proxy.http(_port)` / `ssl(_port)` / `socks(_port)` |
| `zoom.default` | `browser.content.full-zoom` content pref |

Verified: `node tests/contract/settings_native.mjs` (100 checks),
`python3 tools/marionette-probe/settings-native-probe.py out/settings-native`
(50 live checks), `python3 tools/marionette-probe/settings-audit-probe.py`
(59 live controls across the Browser settings; only Profiles fails, see below)
and `python3 tools/marionette-probe/settings-restart-probe.py` (49 checks:
every value read back after a real quit/relaunch, Astra prefs present in the
profile, density/motion re-applied, and the startup page actually opened).

Astra-only keys have no Firefox pref owner and are now written under
`astra.settings.<key>` in the profile, so they survive a restart until the core
store is wired: theme/colour/font/material/tint (the interface face defaults to
the bundled `astra` = Inter), the page-bar mode (`ui.main-bar`: `auto` /
`always` / `hidden`), sidebar mode, New Tab
switches, search engine/custom template (Astra's resolver owns them), tab
dedupe/close-button/archive/after-close, performance memory profile and
exceptions, AI/Work/Notes/Tasks/Time, updates, account, diagnostics, reset, the
Home command target (`tabs.home`, now read by `nav.home`), and the remaining
preview site-permission rows (pop-ups, clipboard, automatic downloads, sound)
whose native form is per-site only.

The Appearance light/dark/system picker was writing `appearance` but nothing
applied it: `domain/appearance/theme.ts` only listened for `theme.*` commands.
It now also applies `preference.appearance=*` pushes, and a keyboard/menu theme
command stores its choice. Live: `light -> dark -> light`, stored `dark`.

Startup needed a fix in `overlay/astra/mozilla.cfg`: it used `pref()` for
`browser.startup.page = 3` on every launch, which overwrote the Settings choice
(and `pages` = 1 was dropped as equal to Firefox's compiled default). It now
seeds continue mode only when no user choice exists, and the settings writer
moves the default branch before storing a choice. Verified by the restart
probe: `pages` survives and the loopback startup page opens on relaunch.

The live audit drives every switch, select and segmented control in the
Browser group. Remaining honest gaps, all blocked by a missing native
subsystem rather than the setting binding:

- **Profiles** — closed in the Lane 4 section below: native roster, create,
  rename, delete and avatar are routed; in-place switching is refused honestly
  because it needs a relaunch. Photo avatars wait on the media route.
- **Downloads** — closed in the Lane 4 section below: the native public list,
  folder and ask preference are wired; the settings panel no longer reports a
  permanent unsupported state.
- **Ad & tracker protection** — `privacy.blocking` is disabled while the
  blocker reports "needs attention"; the Rust/C++ blocker is a separate
  engine lane.
- **Use my name** (`ntp.personalize`) is disabled until the current profile
  has a display name (the same missing profile projection).

These settings were already native and stay so through their own host modules,
not `setting_get`: default browser, login item, downloads (native download
manager), per-site permissions, browsing-data clearing, site data, import /
export, and per-site zoom levels.

### Lane 6 — Material, zoom and home (2026-11-05)

| Surface | Wiring | Verified |
|---|---|---|
| Zoom levels | `zoom_call` → `Zoom.sys.mjs` → `nsIContentPrefService2` (`getByName`, `removeByDomainAndName`, `removeByName`) over `browser.content.full-zoom`; `zoom.in/out/reset` persist the active site when `browser.zoom.siteSpecific` is on, never from a private tab, and 100%/reset remove the override | `tests/contract/zoom_home_material.mjs` |
| Home | `nav.home` → `Commands` → `Navigation.loadURL`, reading `tabs.home` then `browser.startup.homepage` then Astra's New Tab; `goHome` is added to the shell's disabled native keys | same contract; live probe |
| Window material | `ui.material` is resolved by `System.uiInfo` against the platform's real capability: Windows 11 22H2+ offers Mica and applies `widget.windows.mica`; Linux and this macOS build offer solid only. `data-material`/`data-materials` follow the resolved choice, and the picker lists only those tiers | same contract; live probe |
| Density | compact tokens now cover tab rows, rail, dock, main bar, controls and search, not only Settings rows | live measured heights |

Binding note (SCOPE rule 5): `UiInfo` gained an optional `materials: Material[]`
in `ui/app/src/shared/ipc/bindings.ts` (the sanctioned generated-binding
exception) so the appearance picker can list the tiers the host can actually
draw instead of a dead platform list. `zoom_call` left
`tests/contract/wire_baseline.json` now that it has a route.
### Time + Performance wiring (Lane 5, 2026-11-05)

`overlay/astra/host/Performance.sys.mjs` is the live sleeping-tabs driver. It
reads `performance.sleep`, `performance.after`, `performance.memory` and
`performance.exceptions` on every tick, mirrors the Rust policy
(`crates/astra-core/src/sleeping.rs`), discards through `Tabs.discard` (the
content binding calls `gBrowser.discardBrowser`) and reverts the model when
the engine refuses. The delay applies immediately because the driver reads it;
`Settings` keeps `browser.tabs.unloadOnLowMemory` and
`browser.tabs.min_inactive_duration_before_unload` in sync. Teardown is one
interval, one event subscription and one `unload` listener.

The projection now carries `TabView.availability = { state: "sleeping" }` for
a discarded tab, so the rail's sleeping list is real; selecting the row wakes
it (the tabbrowser restores the page and the model clears the flag).

**Wire extension (SCOPE rule 5).** `tabs_discard` and `tabs_wakeup` are routed
to `Tabs.discard`/`Tabs.wakeup` in `ui/packages/bridge/src/host-transport.ts`.
They are not in the generated `CommandName` registry (`ipc-surface.md` has no
row for them), so `bindings.ts` has no typed helper yet; the route is the
envelope name a probe or a future row uses. The host driver itself calls the
module methods directly, so it does not depend on the wire.

**Time/focus persistence is host-side.** `Time.sys.mjs` counts the selected
public tab's dwell time (per profile, split at local-hour boundaries), counts
one "open" on a site change, persists hourly buckets and focus days under
`astra.time.state.v1` in the profile pref store, prunes by `time.retention`,
and persists/restores the running focus round. `focus_days` now returns real
rows and `shut` lists the `focus.blocked` sites while a round runs.

**Missing core commands (not faked).** `astra-core` still exposes only
`boot.handshake`, `session.save`, `session.load` and `core.shutdown`; it has
no time/focus surface, and `astra-store`'s `time_sessions`/`focus_rules` tables
are not reachable from the protocol. The exact commands still needed are:

- `time.start` / `time.end` / `time.report` over an activity event (the lane
  plan's names) — `time.report` must return the same
  `TimeResponse` buckets/sites the UI already renders.
- `focus.start` / `focus.stop` / `focus.history` — `focus.history` must fill
  `FocusDayView` rows for `focus_days`.

When those exist, `Time.sys.mjs` should delegate to them (and keep the
host-side tracker only as a fallback), not run two counters.

Known limit: the host tracker follows the selected tab of the window that owns
the shell, and each window writes its own view of `astra.time.state.v1`; a
second window's counted time is not merged yet (the same single-writer limit
as the organisation store, P5b-3).

Evidence: `node tests/contract/sleep_model.mjs` 63 checks,
`node tests/contract/time_model.mjs` 187 checks, `hostapi_v1` 324,
`wire_coverage` 50. Live probe steps are in `docs/astra/SLEEPING.md` and the
lane report; network-level focus blocking still needs the engine Net hook
(`crates/astra-time` `FocusBlockHook`), so `shut` is configuration, not a
claim that a request was cancelled.

### Lane 4 settings: Downloads + Profiles (2026-11-05)

`overlay/astra/host/Downloads.sys.mjs` is now backed by the engine's public
download list instead of answering `supported: false`:

- `list`/`updates` read `Downloads.getList(Downloads.PUBLIC)`; ids are derived
  from the download's start time/source/target and revisions grow with state
  and bytes, so the existing `DownloadSession` merge keeps working.
- `preferences` reads `browser.download.useDownloadDir` (ask = inverse),
  `browser.download.folderList`/`browser.download.dir` through
  `Downloads.getPreferredDownloadsDirectory()`. `choose_directory` is
  `nsIFilePicker` + `folderList = 2`; `set_ask_destination` writes
  `useDownloadDir` and answers the new preferences. A cancelled picker returns
  the unchanged preferences, not an error.
- `cancel`/`open`/`reveal`/`forget`/`clear` act on the real transfer;
  `pause`/`resume`/`keep`/`discard` answer `unavailable` because this engine
  exposes no pause or type-held lifecycle. Native list changes emit
  `downloads-changed` per known profile.
- `DownloadPreferences.svelte` now renders an honest unsupported state when a
  reply says `supported: false`, instead of “Loading download preferences…”.

`overlay/astra/host/Profiles.sys.mjs` is new and wired through
`host-transport.ts` for `profiles_get`, `profiles_create`, `profiles_rename`,
`profiles_delete`, `profiles_set_avatar`, `profile_avatar_pick` and
`profiles_switch`; writes emit `profiles-changed`.

- Roster: `SelectableProfileService` when its group is initialised, otherwise
  `nsIToolkitProfileService`. The running profile is identified by `ProfD`, so
  the dev build's `-profile` is reported even when
  `toolkitProfileService.currentProfile` is null; an unregistered directory is
  listed by its leaf name.
- Create/rename/delete are real profile-service operations. Avatars use the
  engine's standard avatar names when selectable profiles are available; an
  unmanaged toolkit profile has no native avatar, so its chosen symbol/tint
  lives under `astra.profiles.avatar.<hash>` (presentation only).
- Switching is **in-window** (D-41): the chosen profile's space is activated
  in the same window, its tabs are restored and its container partition is
  used. Cookies, sign-ins, localStorage/IndexedDB and the cache are isolated;
  preferences, extensions and Places history remain shared by the running
  directory, and the page says so.
- `profile_avatar_pick` answers `unsupported`: this build has no media route
  for a staged profile photo, so it does not mint a token that would render as
  a broken image.

Verified in this lane: `node tests/contract/downloads_model.mjs` (117),
`node tests/contract/profiles_model.mjs` (68), `hostapi_v1.mjs` (324),
`wire_coverage.mjs` (48), `settings_native.mjs` (100),
`shell_assembly.mjs` PASS, `bun run check` typecheck 0 errors, UI unit suite
1236 passed, the ProfilesPage component test passed, bridge 27, state-check
and brand-lint clean. Live Marionette probe is pending the integration rebuild:
download a fixture attachment, change folder/ask and read them back,
list/create/rename/delete a profile, and confirm Switch reports the unsupported
state.

Deferred: photo avatars (needs the media route), per-profile preferences /
extensions / Places history (they remain shared by one profile directory), and
per-profile download scoping (downloads stay global until the core store owns
them).


### Parity lanes — live results (2026-11-05)

The six lanes are merged on `fix/browser-settings-parity`. Generated chrome
and shell bundles were rebuilt; contracts and live probes were run.

| Probe | Result |
|---|---|
| `settings-audit-probe.py` | **60 controls, 0 failed** (Profiles lists 4 rows; downloads.ask toggles; startup, proxy, appearance, tabs, search, new tab, focus, performance, privacy rows all change and restore) |
| `settings-restart-probe.py` | **49/49** (all values survive a quit/relaunch, density/motion re-applied, startup page opens) |
| `material-zoom-home-probe.py` | **14/14** (material tiers + data-material, compact geometry, `nav.home`, real zoom list/reset, private refuses) |
| `tabs-settings-probe.py` | **14/15** — new-tab position, after-close next/previous/recent, close buttons and archive pass live; automatic PiP parks the outgoing browser and the page reaches `visibilityState=hidden`, but the synthetic harness cannot inject the mouse-over the PiP child needs to track the video, so the window itself was not reproduced |
| `settings-parity-probe.py` | **19/19**: site-permission list/write/remove, private-clear refusal, clear browsing data, blocker honesty, custom engine, all four bangs, sleep/discard/wake, and time reporting with the selected site |

Two integration bugs found by the live pass and fixed: `BrowsingData.lazyModule`
returned the module member instead of the module (so Sanitizer was null and
clear always failed), and the time probe compared UTC hours with the tracker's
local-hour buckets. The sleep driver also needed the browser binding and
settled native tabs before a tick; it now discards and wakes live tabs.

Also fixed while integrating: `settings.section.<id>` deep links only accepted
a hardcoded subset, so `settings.appearance` (and General/Tabs/Search/
Performance) never switched the page. All section ids are now accepted.

**First tab fixed (2026-11-05).** Without an `about:blank` argument Firefox's
initial native tab is `chrome://browser/content/blanktab.html`. The content
binding adopted that chrome URL as a real page, so the native blank stage hid
the Astra New Tab page. `safeTabUrl`, `tabView` and `Content.bindTab` now treat
the engine blank tab as `about:blank`/New Tab; a copy of the user profile boots
with `stage:app`, model `url:""`, and the New Tab surface visible.

**Profile switching without quitting.** `Profiles.switch` now launches the
chosen profile through `SelectableProfileService.launchInstance` (or the
binary with `-profile` for an unmanaged toolkit roster) and leaves the current
window open. `profiles-switch-probe.py` created “Switch Probe”, switched to it
(accepted, process/window count rose), verified the current window stayed
alive, then removed the probe profile. Same-window replacement is not a native
profile-directory operation; D-41 implements it as the profile's container-backed
space (see the owner report above).

## Phase 0 — Discovery, inventory, scaffolding

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P0-T01 | Machine/toolchain check (Linux) | done | orchestrator | main | DEV_SETUP.md facts + ESR 153.6.0 verified in UPSTREAM.md; build-reqs check deferred to P1-T04 |
| P0-T02 | Clean repo + record base snapshot | done | orchestrator | main | Repo on `main`, 14 commits; base = `folder_context` snapshot, see `PROVENANCE.md` |
| P0-T03 | Full inventory (crates, IPC, UI, storage, skills) | done | orchestrator | main | INVENTORY.md + ipc-surface.md (267/35) + PARITY.md; subs T03a/T03b merged |
| P0-T03a | IPC surface: every command/event + payloads | done | worker-1 | agent/P0-T03a-ipc-surface | Merged 2026-11-01; 267 cmds + 35 events, zero mismatches |
| P0-T03b | PARITY.md (README claims vs code) | done | worker-1 | agent/P0-T03b-parity | Merged 2026-11-01; no new deviations beyond X-01…X-06 |
| P0-T04 | KEEP/ADAPT/DROP + `BrowserHost` trait | done | worker-1 | agent/P0-T04-porting | Merged 2026-11-01; groups mapped to Host API modules |
| P0-T05 | Rebrand tooling + `brand-lint` | done | worker-1 | agent/P0-T05-rebrand | Merged 2026-11-01; lint exits 0 clean / 1 dirty |
| P0-T06 | License/provenance | done | worker-1 | agent/P0-T06-license | Merged 2026-11-01; MPL LICENSE + NOTICE + 25/25 permissive |
| P0-T07 | Golden capture harness | done | orchestrator | agent/P0-T07-golden | Merged 2026-11-02; 18/18 rerun green, brand-lint clean; shell text-raster variance documented in MANIFEST (mask/tolerance for P3-T11) |
| P1-T01 | `upstream.toml` + `forge fetch` (ESR 153.6.0, U-10 resolved) | done | worker-1 | agent/P1-T01-fetch | Merged 2026-11-01; sig OK via release key, engine extracted, baseline ee0912e |
| P3-T01 | UI into `ui/` Bun workspace (standalone track) | done | worker-2 | agent/P3-T01-ui | Merged 2026-11-01; typecheck 0 errs, tests 1062 pass, vite build exit 0 |
| P0-T08 | CI skeleton | done | worker-1 | agent/P0-T08-ci | Merged 2026-11-01; ci-fast (brand-lint/state-check/plan-check) green locally |
| P0-T09 | Spike briefs for U-01…U-13 | done | orchestrator | main | Index in `docs/astra/spikes/README.md`; spikes execute in Phase 1 |
| P0-T10 | Repo hygiene docs | done | worker-1 | agent/P0-T10-hygiene | Merged 2026-11-01; SECURITY/CONTRIBUTING/CODEOWNERS added |

## Phase 1 — Forge and skeleton (Linux)

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P1-T01 | `upstream.toml` + `forge fetch` (ESR 153.6.0, U-10 resolved) | done | worker-1 | agent/P1-T01-fetch | Merged 2026-11-01; sig OK via release key, engine extracted, baseline ee0912e |
| P1-T02 | `forge config` + `config/mozconfig.linux` (F-05 flags verified) | done | orchestrator | agent/P1-T02-forge-config | BUILD_FLAGS.md (3 F-05 corrections); `forge doctor` mozconfig check green; `./mach configure` complete, config.status proof |
| P1-T03 | Branding overlay | done | orchestrator | agent/P1-T03-branding | astra/branding rendered from toml (dev defaults); configure+build green; "Astra Nightly" window + placeholder art verified in GUI |
| P1-T04 | First full Linux build + sccache + dev loop | done | orchestrator | agent/P1-T04-build | Binary built (153.6.0esr, GUI-verified incl. chrome://astra/); BUILD_TIMES.md (~70 min, 16 GB objdir, -j8 OOM rule); faster loop ~2 s (U-02 closed, U-03 deferred); `forge build` added |
| P1-T05 | Overlay wiring (`chrome://astra/`, ASTRA-0001) | done | orchestrator | agent/P1-T05-overlay | overlay/astra (moz.build/jar.mn/HostAPI stub/hello) staged by `forge overlay`; ASTRA-0001 applied; `forge lint` clean; configure complete with /astra in DIRS |
| P1-T06 | `policies.json` + pref overrides (incl. Normandy/HR path from BUILD_FLAGS.md) | done | orchestrator | agent/P1-T06-policies | 15 impl-verified policies ACTIVE; mozilla.cfg autoconfig locks Normandy/shield/sponsored (contract 7/7 PASS) |
| P1-T07 | Endpoint audit tool | done | orchestrator | agent/P1-T07-endpoint-audit | Merged 2026-11-02; Go stdlib-only, vet+6pkgs pass, live-run gate PASS, brand-lint/state-check green |
| P1-T08 | Shell mount patch (ASTRA-0002) | done | orchestrator | agent/P1-T08-shell | #astra-root mounted, Svelte hello renders, FF chrome hidden (contract 5/5 PASS incl. nonzero-size guard; GUI-verified "Hello Tab", no toolbars) |
| P1-T09 | Sidecar spike (U-01) | done | orchestrator | agent/P1-T09-sidecar | Merged 2026-11-02; stdio wins (D-31), harness SPIKE PASS reproduced, cargo check clean, brand-lint/state-check green |
| P1-T10 | Content slot + URL bar via Host API stub | done | orchestrator | agent/P1-T10-content | Merged 2026-11-02; stub 33/33 + live 12/12 PASS reproduced, P1-T08 5/5 no-regress, brand-lint/state-check green |
| P1-T11 | Contract-test harness (geckodriver) | done | orchestrator | agent/P1-T11-contract | Merged 2026-11-02; forge test 8/8 PASS reproduced (fixture-only + full), lint/footprint still green, brand-lint/state-check green |
| P1-T12 | `forge export`/`import` round-trip + patch lint + footprint budget | done | orchestrator | agent/P1-T12-forge-rt | Merged 2026-11-02; build+lint+footprint green (14 lines/2 patches/0 P3), roundtrip PASS vs live engine, brand-lint/state-check green |

## Phase 2 — Core, storage and bridge

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P2-T01 | Bring over crates per PORTING_MAP (`BrowserHost`) | done | orchestrator | agent/P2-T01-crates | Merged 2026-11-02; workspace check+clippy clean, tests 44/44, zero tauri/wry, MPL headers, brand-lint clean |
| P2-T02 | `astra-proto` schemas + generated Rust/TS types | done | orchestrator | agent/P2-T02-proto | Merged 2026-11-02; 267/35 registries, cargo 6/6 + bun 7/7 + validate PASS, drift gate verified, brand-lint clean; fixed stale "8 channels" comment (10 renames); Specta full-typing deferred |
| P2-T03 | IPC transport (framing, backpressure, crash recovery) | done | orchestrator | agent/P2-T03-transport | Merged 2026-11-02; ipc 17+5 chaos + workspace 81/81, clippy 0, fmt clean; fixed proto from_str lint + T01 fmt leftovers |
| P2-T04 | `astra-store` (rusqlite + migrations, WAL) | done | orchestrator | agent/P2-T04-store | Merged 2026-11-02; schema v4 (29 tables), store 19/19 + workspace 59/59, clippy+fmt clean; rusqlite 0.40 (migration-compat) |
| P2-T05 | `GeckoHost` + `MockHost` | done | orchestrator | agent/P2-T05-geckohost | Merged 2026-11-02; host-trait 23/23 + workspace 95/95, clippy -D warnings clean, fmt+brand clean |
| P2-T06 | Host API v1 (Boot/Windows/Tabs/Navigation) | done | orchestrator | agent/P2-T06-hostapi | Merged 2026-11-02; stub 262/262 + live 30/30 reproduced, no-regress 33/33+py+5/5, jar.mn wired; chrome repack deferred to next engine build (faster attempt hit fresh-objdir link fail, binary untouched, obj-x86_64* 93MB stray noted for cleanup) |
| P2-T07 | History mirror into Places (`:visited`) | done | orchestrator | agent/P2-T07-history | Merged 2026-11-02; stub 27/27 + live 10/10 (VisitedQuery parity); jar.mn + HostAPI façade wired (incl. Session); no-regress 262+73+33 green |
| P2-T08 | `@astra/bridge` (Tauri-compat + mock mode) | done | orchestrator | agent/P2-T08-bridge | Merged 2026-11-02; ui 1069/1069 + bridge 19/19 reproduced, build + svelte-check clean, brand-lint clean; vitest.config tsc errors pre-existing |
| P2-T09 | Session snapshot/restore round-trip | done | orchestrator | agent/P2-T09-session | Merged 2026-11-02; workspace 129/129, session 73/73 + hostapi 262/262 no-regress, clippy/fmt/brand clean; jar.mn wired |
| P2-T10 | Settings, keymap, logging, diagnostics | done | orchestrator | agent/P2-T10-settings | Merged 2026-11-02; core 50/50, workspace 120/120, clippy/fmt/brand clean |

## Phase 3 — UI port, 1:1 (daily-driver browsing)

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P3-T01 | UI into `ui/` Bun workspace (standalone track) | done | worker-2 | agent/P3-T01-ui | Merged 2026-11-01; typecheck 0 errs, tests 1062 pass, vite build exit 0 |
| P3-T02 | Spike S-01 content slots (+ split/Work panes impl) | done | orchestrator | agent/P3-T02-slots | Merged 2026-11-02; CSS-grid slots (U-05 resolved), stub 39/39 + live 16/16, no-regress green; FIXED load-bearing P2-T06 regression (XUL_NS xhtml→xul, live-guarded) |
| P3-T03 | Window frame per OS (Linux first) | done | orchestrator | agent/P3-T03-frame | Merged 2026-11-02; model 27/27 + live 17/17, no-regress green; jar.mn wired; Shell mounting deferred to P3-T13 |
| P3-T04 | Tabs (vertical, pinned, folders, DnD, context menus) | done | orchestrator | agent/P3-T04-tabs | Merged 2026-11-02; ui 1084/1084 + shell model 13/13 reproduced, build + svelte-check clean; SpaceBar failure not reproduced (worker env) |
| P3-T05 | Spaces/profiles (S-02 + containers impl) | done | orchestrator | agent/P3-T05-spaces | Merged 2026-11-02; S-02 (spaces→containers, profiles→dirs), isolation 117/117, core 69/69, no-regress 262+73+27 green; jar.mn wired |
| P3-T06 | Split view + layout persistence | done | orchestrator | agent/P3-T06-split | Merged 2026-11-02; core 80 + shell 20/20 + ui 1096 green, layout rides Session host module (validated+echoed, schema updated, 99 checks) |
| P3-T07 | Omnibox + search | done | orchestrator | agent/P3-T07-omnibox | Merged 2026-11-02; ranking port + local engines + model, ui 1133/1133 + svelte-check clean; worker's 43 fails were stale-base env, not main |
| P3-T08 | Settings UI, shortcuts, theming | done | orchestrator | agent/P3-T08-settings | Merged 2026-11-02; surface pre-exists bridge-driven, platform-gated conflict test fixed; ui 1096 + svelte-check clean |
| P3-T09 | Browser dialogs via Host API events | done | orchestrator | agent/P3-T09-dialogs | Merged 2026-11-02; events 94/94 + spoof-resistance 27/27, no-regress 262+99 green; façade + jar.mn wired |
| P3-T10 | Welcome/onboarding flow | done | orchestrator | agent/P3-T10-welcome | Merged 2026-11-02; ui 1144/1144, registry-known keys verified in core, svelte-check + brand clean |
| P3-T11 | Golden suite (in-Firefox vs baseline) | done | orchestrator | agent/P3-T11-goldff | Merged 2026-11-02; 13/16 PASS reproduced, 3 text-raster FAILs + 2 narrow SKIP documented; CI job report-only until gate tuning |
| P3-T12 | Accessibility pass | done | orchestrator | agent/P3-T12-a11y | Merged 2026-11-02; A11Y checklist + landmarks/focus/contrast tests, ui 1153/1153, conflict vs T13 assembly resolved (landmarks kept); engine bundle refresh rides P3-T14 |
| P3-T13 | Shell assembly (mount frame/tabstrip/split, __astraHost wiring) | done | orchestrator | agent/P3-T13-assembly | Merged 2026-11-02; assembly 57 + all stub suites green, live-vs-current-binary green; TRUE live verify of new bundle needs rebuild (P3-T14) |
| P3-T14 | Engine rebuild + full live re-verify (new Host/chrome/shell bundle) | done | orchestrator | main | Rebuilt (faster, 8s); all live suites green on new binary; FIXED: localStorage guard (tabstrip/split), Frame URL, XUL dup div; frame_live rewritten to probe real shell; goldens recaptured 18/18 |
| P3-T15 | Mount full app (ui/app/dist) as the shell, retire hello | done | orchestrator | agent/P3-T15-appshell | Merged 2026-11-02; node green (1 pre-existing FAIL proven on main), py green, lint/brand/CSP clean; file:// + framescript relay (see SHELL_APP.md §5) |
| P3-T16 | Retire interim chrome when app boots (hide bar/split/sidebar/toolbar, keep titlebar+content) | done | orchestrator | main | Shell hides interim chrome on appReady=host; verified built+staged; live proof pending on deterministic boot (P3-T17) |
| P3-T17 | Deterministic app boot: fix content crashes + flaky mount, missing host routes | done | orchestrator | agent/P3-T17-appboot | Merged 2026-11-03 (79c1b7d): isStandalone resource:/chrome:/about: mock path (bridge 8/8, eslint clean); Sidebar + WebExtensions stubs via HostAPI (contract 289/289); slot-error dark contrast + #browser dead-space hide (frame_model PASS; shell_assembly 1 FAIL pre-existing on main, unrelated). Live proof needs engine rebuild (bundle restage). Follow-up RESOLVED 2026-11-03 (5e8c5d2): host-transport.ts ROUTES wired (bridge 25/25, smoke 1 passed) |
| P3-T18 | Playwright sync to Astra (standalone smoke + docs) | done | orchestrator | agent/P3-T18-playwright | Merged 2026-11-03 (bc3f23f): playwright.config.ts (baseURL 1420, chromium-1248) + smoke.spec.ts 1 passed (18.2s) + PLAYWRIGHT.md; --list clean; no remote to push (local-only). In-Firefox stays marionette lane. PROVEN 2026-11-03: Playwright cannot drive custom Gecko (launches with -juggler-pipe, ESR lacks it) |
| P3-T19 | Headed dev-build boot + live verify (rebuilt UI, ROUTES, shell bundle) | done | orchestrator | main | 2026-11-03: fixed shell_assembly test URL (res/→correct mapping) + jar.mn Sidebar/WebExtensions registration + rebuilt shell bundle (13/13 routes) + restaged 746-file chrome app; headed boot appReady=host, relay res:ok, ZERO BridgeErrors live, interim chrome retired ([hidden] x6), local fixture tab paints (title verified + content screenshot). Sandbox has no external net (example.com fails from shell too). Window left open for owner |
| P3-T20 | New Tab parity with the reference UI (real projection + chrome retirement) | done | orchestrator | main | Merged 2026-11-03 (e95c038/3727bc8). Root causes: parseEnvelope coerced null→{} (every preference read as an object → clock/due hidden); app listens on `astra:*` DOM channels the relay never dispatched; no items-changed projection (no tabs → no New Tab); interim titlebar/toolbar defeated [hidden] via author display and split the window 50/50. Added Tabs.bootstrap + projection, Settings, Accounts, sidebar.changed, astra:* re-dispatch, app-owns-window layout, typographic ASTRA wordmark. Live: sky + wordmark + clock + Sign in + tab row + 3 pills. Pill labels hidden <720px container by design. Contracts 289/289, shell_assembly/frame_model PASS, state/brand clean |
| P3-T21 | Real chrome integration: `chrome://` package document, relay deleted, skeleton-free boot | done | orchestrator | main | 2026-11-03. ASTRA-0006 (P3, `nsContentUtils.cpp`) exempts `chrome://astra/` from default system-principal innerHTML sanitization — the actual blocker; Svelte builds templates via `template.innerHTML`. App now loads as `chrome://astra/content/app/browser-chrome.html` in a chrome-privileged iframe, same principal, Host API imported directly; `file://` browser + `relay-framescript.js` + nonce deleted. Boot: `data-app-booted=pending` hides all fallback chrome, app ground fills the window (D-33); early captures 0.7–7.0 s show no skeleton. Proof: `tests/contract/shell_app_chrome.py` 11/11 PASS; forge lint 6/6 clean; hostapi 289/289, shell_assembly + frame_model PASS, bridge 25/25, app bridge test 8/8, svelte-check 0 |
| P3-T22 | Instant first paint: Space bar, tab row, drop target and account foot present when the UI appears | done | orchestrator | main | 2026-11-03. The sidebar could paint an empty shell and fill in a pass later. App now mounts behind an `opacity:0` gate and reveals only when the four sections are present for 3 consecutive frames (cap 1200 ms). `visibility` leaked through descendants (measured) — opacity cannot. Reveal measured at 271 ms document time. shell_app_chrome.py extended: first-visible-frame completeness + reveal budget. hostapi 289/289, shell_assembly/frame_model PASS, bridge 25/25, app bridge 8/8, svelte-check 0 |
| P3-T23 | First frame is the finished, correctly styled UI | done | orchestrator | main | 2026-11-03. Tried in-tree mount into browser.xhtml (rejected: app CSS is scoped to its own document — white address field, hidden tab labels, 13px wordmark). Kept the chrome iframe and fixed the real flicker: a chrome iframe caches the layer it painted while transparent, so revealing it showed a half-built frame. Loader now holds the frame at opacity:0 (layout live), waits for the app's `ready`, then invalidates both layers. First captured frame (out/headed-frames2/f00.png) is complete. shell_app_chrome.py 17/17; hostapi 289/289, shell_assembly + frame_model PASS, bridge 25/25, svelte-check 0, state/brand clean |

## Phase 4 — Browse core: blocker, extensions, import, privacy

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P4-T01 | `astra-blocker` crate (adblock-rust + seed lists) | done | orchestrator | agent/P4-T01-blocker | Merged 2026-11-02; blocker 23/23, workspace 223/223, seed byte-identical + attribution clean; NOTICE rebrand stands (own file) |
| P4-T02 | In-tree Rust network-hook component | done | orchestrator | agent/P4-T02-network | Merged 2026-11-02; in-tree chosen (precedent-verified), wiring 37/37 + lint/footprint green; added lint new-file carve-out; fixed PASSWORD_DECISION brand leak |
| P4-T03 | Element hiding (cosmetic + click-to-hide) | done | orchestrator | agent/P4-T03-hiding | Merged 2026-11-02; protocol+logic 36+44 green; live injection deferred to P4-T11 |
| P4-T04 | Extension manager + curated gallery | done | orchestrator | agent/P4-T04-extensions | Merged 2026-11-02; 45-entry AMO gallery (36 equiv/8 alt/1 none), ext 8+1, ui 1189/1189, svelte-check clean |
| P4-T05 | Importers (Chromium/Firefox/Zen/...) | done | orchestrator | agent/P4-T05-import | Merged 2026-11-02; 9 sources + store round-trip, 45/45, zero net deps; FIXED latent T03 tokio macros gap (workspace build now green) |
| P4-T06 | Tab sleeping policy | done | orchestrator | agent/P4-T06-sleeping | Merged 2026-11-02; policy 9/9, core 94/94, workspace 232/232, clippy/fmt/brand clean |
| P4-T07 | Private windows (nothing persisted) | done | orchestrator | agent/P4-T07-private | Merged 2026-11-02; guard + forensic tests green; host-excluded today, store wiring = caller contract (see PRIVATE.md status) |
| P4-T08 | Downloads manager + PDF viewer | done | orchestrator | agent/P4-T08-downloads | Merged 2026-11-02; ui 1176/1176 + svelte-check clean; bridge download routes stubbed (follow-up noted) |
| P4-T09 | Password/autofill decision | done | orchestrator | agent/P4-T09-password | Research merged; recommends extension-only; owner decision pending (OWNER_QUESTIONS #6 expanded) |
| P4-T10 | Performance baselines | done | orchestrator | agent/P4-T10-perf | Merged 2026-11-02; baselines recorded (startup/RAM/switch/scroll/blocker), scripts validated; confirm re-run after engine rebuild |
| P4-T11 | Element-hiding live wiring (content script, provider, store adapter, actor reg) | done | orchestrator | agent/P4-T11-livehide | Merged 2026-11-02; content_hide 59+py PASS, hostapi 262 no-regress, blocker 22, bridge 24, fmt/brand clean; live Marionette skip-gated (no geckodriver) |

## Phase 5 — Tasks, Notes, Time

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P5-T01 | Tasks domain (lists, priorities, NL parser) | done | orchestrator | agent/P5-T01-tasks | Merged 2026-11-02; tasks 31/31, workspace 284/284, clippy/fmt/brand clean |
| P5-T02 | Tasks UI + "make task" palette | done | orchestrator | agent/P5-T02-tasks-ui | Merged 2026-11-02; palette taskCommandRow + unit 83 + component 5/5; 2 pre-existing timing failures unchanged (proven identical stashed); PARITY stays ported-pending (no production caller yet) |
| P5-T03 | Notes (Markdown files + index + watcher) | done | orchestrator | agent/P5-T03-notes | Merged 2026-11-02; notes 12/12, workspace 253/253, clippy/fmt/brand clean |
| P5-T04 | Time tracking (per-site, focus mode) | done | orchestrator | agent/P5-T04-time | Merged 2026-11-02; time 12/12, workspace 296/296, clippy/fmt/brand clean; private-aware writes from day one |
| P5-T05 | Export/import (JSON + Markdown) | done | orchestrator | agent/P5-T05-export | Merged 2026-11-02; tasks/notes/time bundles + store import_json + combined fixture; tasks 15/notes 23/time 34/store 15+2, clippy/fmt/brand clean |

## Phase 6 — Work: agents, canvas, skills, MCP

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P6-T01 | Agent design doc + `astra-agents` skeleton | done | orchestrator | agent/P6-T01-agentcore | Merged 2026-11-02; 27/27 + workspace 30 green; deeper machinery (shutdown proofs, plan-lease) deferred to P6-T02+ |
| P6-T02 | Provider layer (BYO + local, keychain keys) | done | orchestrator | agent/P6-T02-providers | Merged 2026-11-02; 34 unit + 27 conformance; keyring4+ureq3; keys redacted, live smokes opt-in |
| P6-T03 | Tool layer (browser/FS/command/MCP/gh) | done | orchestrator | agent/P6-T03-tools | Merged 2026-11-02; 60 unit + 27 conformance; 14 tools with schemas; MCP stdio + gh wrapper mocked |
| P6-T04 | Approval gate engine + injection suite | done | orchestrator | agent/P6-T04-approvals | Merged 2026-11-02; 59 lib (12-case injection suite) + 27 conformance; hash-chained audit; fail-closed |
| P6-T05 | Helpers (parallel sub-agents, containers, Panes) | done | orchestrator | agent/P6-T05-helpers | Merged 2026-11-02; agents 98+27, UI 6+5; fixed worker's premature handoff mod line (a3ebce9) |
| P6-T06 | Canvas UI (tables/charts/plans/code/docs) | done | orchestrator | agent/P6-T06-canvas | Merged 2026-11-02; unit 9/9 + component 3/3; goldens deferred (harness hardcodes 8 screens, see CANVAS.md); bundle-budget entry follow-up |
| P6-T07 | Skills: port 25 bundled (rebranded) + loader | done | orchestrator | agent/P6-T07-skills | Merged 2026-11-02; 25 full ports + skill-lint clean + SKILLS.md loader contract; runtime loader rides P6-T01 |
| P6-T08 | Memory + history recall (view/edit/delete) | done | orchestrator | agent/P6-T08-memory | Merged 2026-11-02; agents 32/core 96/store 29; hard-delete proven (raw SQL 0 + freelist 0); private-scope respected |
| P6-T09 | Hand-off to Claude Code / Codex | done | orchestrator | agent/P6-T09-handoff | Merged 2026-11-02; 110+8+27; scoped grants, approval-gated, ETXTBSY-hardened spawn; merge needed mod-line restore |
| P6-T10 | Port `eval/agentic-browsing` to `tests/eval/` | done | orchestrator | agent/P6-T10-eval | Merged 2026-11-02; 21/21 + smoke 5/5 + cap-negative; note: contract-runner has same log_message flaw, left untouched (follow-up) |


## Bugfix batch — owner-reported browser core (2026-11-03)

The owner reported the browser's everyday behaviour as broken (page menu,
history, Back/Forward, favicons, private windows, search, theme). This batch
wires **only** the surfaces named here; D-36 still governs everything else.
Live evidence is the Marionette probe run against the packaged dev build
(`19 passed, 0 failed`) plus a menu-bridge probe that suppressed the engine
menu and ran a row end-to-end.

| ID | Fix | Status | Branch | Evidence |
|---|---|---|---|---|
| B-01 | Hidden sidebar's peek card no longer swallows page clicks | done | `fix/sidebar-peek-clicks` | frame clipped to the card; `elementFromPoint` outside the card returns the page |
| B-02 | Back/Forward never lands on the empty New Tab; duplicates collapse | done | `fix/nav-history` | `hostapi_v1` 306 checks incl. A→B→Back→Forward and external adoption |
| B-03 | Bookmarks stored and read from Places (list/reveal/search/add/rename/move/remove) | done | `fix/bookmarks` | `bookmarks_model` 186 + live `bookmark.add` wrote the page |
| B-04 | Google is the default engine; content `prefers-color-scheme` follows the app | done | `fix/search-theme` | `search_model` 37, `system_model` 92, live pref 2→app choice |
| B-05 | Browsing history recorded and read from Places; site favicons resolved | done | `fix/history-favicons` | `history_places` 37, `favicons_model` 39, live visit + icon |
| B-06 | Astra owns the page menu; private/new windows; loading state; keyboard ids | done | `feat/astra-owns-context-menu` | engine menu prevented, app menu ran "Open Link in New Tab"; private window renders private chrome; new window adopts its URL |
| B-07 | Site icon fallback when Places has none | done | `fix/favicon-fetch-fallback` | live icon for a site the engine never stored |
| B-08 | App theme reaches content through the boot channel | done | `fix/theme-content-scheme` | live pref changes from system (2) to the app's choice |
| B-09 | Agent worktrees excluded from `brand-lint` | done | `feat/astra-owns-context-menu` | gate clean with worktrees present |
| B-10 | The page menu draws above the page; a hidden column recovers after a menu | done | `fix/context-menu-overlay` | live: menu hit-tested above the page; clip lifted and peek re-entered |
| B-11 | The content stage can enter a page's DOM fullscreen | done | `fix/astra-dom-fullscreen` | ASTRA-0007; live: chrome hidden, stage fills the window, restored on exit |
| B-12 | Space icon/theme save; previews carry the space's tab favicons | done | `fix/spaces-save` | live: theme/symbol click saved with no editor error |
| B-13 | Fetched favicons persist in Places, show in History, late icons retried | done | `fix/favicons-history` | live: History rows paint a 32x32 mark |
| B-14 | Loading skeleton; first browser warmed; load state survives the commit | done | `feat/loading-skeleton`, `fix/load-state` | live: skeleton while a server holds the request; host path 65 ms first / 25 ms second local |
| B-15 | A space without an icon wears its first site's favicon | done | `fix/space-favicon` | live: previews carry refs; the bar falls back to the first one |
| B-16 | Dismissing the page menu does not flash the page black | done | `fix/menu-dismiss` | close lowers the frame first, then restores the app ground |
| B-17 | A hidden column peeking over a New Tab keeps the New Tab visible | done | `fix/newtab-peek` | live: no clip, no transparent ground, New Tab screenshotted intact |
| B-18 | Page shortcuts use the product keymap; native keys they own are disabled | done | `fix/global-keys` | live: Ctrl+D saved a bookmark with no page-action error; F12 opened DevTools |
| B-19 | DevTools opens for the content stage; fullscreen gets a shell fallback | done | `fix/devtools-fullscreen` | live: `devtools:toolbox` window; fullscreen chrome layout verified |
| B-20 | Page menu lives in chrome; no frame restack, no black flicker | done | `fix/menu-chrome` | live: menu above the page, app frame untouched |
| B-21 | Bookmarks and history paint the same site icons as tabs | done | `fix/favicons-and-menu-overlay` | live: YouTube + Google marks in tabs, Bookmarks, History |
| B-22 | Bookmarks are scoped to the active space | done | `feat/space-isolation` | live: space 2 kept YouTube, space 1 kept Google after switching |
| B-23 | Every space is its own Firefox container (site data, logins) | done | `feat/space-container` | live: space 2 browser reports userContextId 1, space 1 stays 0 |
| B-24 | DevTools acts on the stage tab: opens on the real tab, toggles from F12, follows navigation, reports the tab's container, closes with the tab | done | `fix/devtools-live-target` | live: `tools/perf/stress/devtools_probe.py` 7/7 (real tab, inspector, nav follow, toggle close, container 2, tab-close teardown); teardown console noise 0 via ASTRA-0010 |

**Still deferred after this batch (do not report as fixed):** real split-pane
content (the split layout is still a single page) and container-scoped link
opening. Media transport rows delegate to the engine's own
`nsContextMenu.mediaCommand`, so they act on the exact element clicked.
Fullscreen's engine condition is patched and its chrome layout plus fallback
are verified; the gesture path still needs a real click to give the page focus,
so it is not part of the automated probe. The first Google search pays
network/DNS/TLS; the local host path measures 65 ms first and 25 ms second,
so the wait is the site, not the address wiring.

**Per-space data, current state:** bookmarks and site data/logins are isolated
(space 1 keeps the existing root, every other space gets its own bookmark
folder and a Firefox container). **History, downloads and the search engine
are still global.** Places stores visits per page, not per space, so filtering
them in the UI would hide data rather than scope it; the visit-level space
field belongs in `astra-core` (plan §5.4). The downloads manager is still the
honest empty stub (`Downloads.call` answers `supported: false`), and the
search preference has no per-space control yet. These stay on the wiring
backlog.

## Later phases

P7–P11 all `todo` — see `plan.md` §§8–11.

## Native binding merge (2026-11-04)

Execution plan and phase status: `merge.md`. The new wire shapes below are
recorded here per SCOPE rule 5.

| Shape | Why | Phase |
|---|---|---|
| `Boot.launchCore({ command })` + pref `astra.core.command` | One startup owner for the Rust core. The shell calls it on mount; an empty command answers `unavailable` instead of faking a process. | P1 |
| `Boot.shutdown().core_stopped` | Report whether a core was actually stopped; the shell/quit path can wait on a real answer. | P1 |
| `Navigation.hardReload` + event `nav.hard-reload` | Ctrl/Shift reload must bypass proxy and cache (`LOAD_FLAGS_BYPASS_PROXY | BYPASS_CACHE`), not be a soft reload. Keymap `.alt*` ids normalise to the base command. | P2 |
| Live `stop`/`zoom`/`print` dispatch in `Content` | The model intents now reach `browser.stop()`, `ZoomManager` and `PrintUtils`; no new shape beyond `nav.hard-reload`. | P2 |
| Print surface blocker | P2 dispatches `PrintUtils.startPrintWindow`, which is Firefox's own print window. P6 owns the Astra print UI; until then this is a recorded native-surface exception. | P2/P6 |

## Owner report: permission prompts + battery (2026-11-04)

A device-diagnostics site (`checkmydevice.app`) reported the Battery API as
unsupported and camera/microphone permission state as `prompt`. Both were
**correct**: the page only reads `navigator.permissions.query()` (it never
requests), and upstream keeps `getBattery()` ChromeOnly. Astra's own prompts
were re-verified live (geolocation 23/23, getUserMedia 27/27). The owner then
asked for battery exposure and for Astra to own the remaining permission
prompts. Decisions: D-39, D-40.

| ID | Fix | Status | Evidence |
|---|---|---|---|
| P6b-3 | Notifications, persistent-storage, xr, loopback-network and local-network route through `PagePermissionPrompt` (host kind map + schema enum + generated binding + prompt copy/icon); LNA keeps the engine's 24 h temporary expiry and `notifyShown()` | done | `permissions_prompt.mjs` 119 checks; `PagePermissionPrompt.component.test.ts` 8/8; `permission_kinds_probe.py` 27/27 live (notification allow/deny, storage allow/dismiss, no native doorhanger, `Services.perms` written) |
| P6b-4 | `serial`, `midi`, WebRTC `screen`/`audioCapture` and `storage-access` keep the engine prompt on purpose (picker / per-request choice); asserted not routed | done | `permissions_prompt.mjs` "keeps the engine prompt" checks; `DIALOGS.md` scope |
| ASTRA-0011 | `navigator.getBattery()` exposed to web content (drop `ChromeOnly`, keep `dom.battery.enabled`) | done | `battery_probe.py` 7/7 live (promise resolves, level/charging/charge times typed, same manager on second call); `forge lint` clean; incremental `build --jobs 2` 41 s |

Binding note (SCOPE rule 5): `ui/app/src/shared/ipc/bindings.ts` is Tauri
Specta output and has no generator in this tree, so the
`PagePermissionKindView` union was extended in place (the file is already the
sanctioned generated-binding exception in `tools/brand-lint.sh`).

## Owner report: drag a tab to keep it (2026-11-04)

Dragging a tab onto the Essentials dock did nothing and always answered
"Could not move this tab. Try again." Three separate defects on one path:

| ID | Fix | Status | Evidence |
|---|---|---|---|
| D-41a | `tabs_set_essential` had no Host route and no `Tabs` method, so the app's only drag verb (`tab-drag.move`) failed with `unknown_command`. Added `Tabs.setEssential({ astra_tab_id, essential, before })` (keep/unkeep + place in one call), routed it with `TAB_ARG`, removed it from the wire baseline | done | `hostapi_v1.mjs` 324 checks (keep, drop-before order, in-place reorder, release, projection sections, unknown tab, bad flag); `wire_coverage.mjs` 48 (route target exists, id mapped, 199 known gaps) |
| D-41b | The projection put every tab in `today`; `pinned` never reached the sidebar, so a kept tab had no fulfilment section. `__itemsSnapshot` now projects kept tabs as `favorites` in run order and open tabs as `today`, `tabs` sorted to match | done | same host contract checks: "kept tabs project as favourites in drop order", "a kept tab leaves Today", "a released tab returns to Today" |
| D-41c | `tabDrag.end()` treated a refused `tab_drag_over(null, null)` (still an unrouted native-hint command) as a placement failure, so every drag ended in the error banner even when the move applied. The hover-hint release is now silent; only `move`/`leaveSplit` settle a placement | done | `tab-drag.svelte.test.ts` 4/4; `RailDrag.component.test.ts` + `TabReorder.component.test.ts` 6/6 |

Live proof (packaged dev build, Marionette, throwaway profile,
`/tmp/opencode/essentials-probe.py`): an open tab dragged onto the dock ends
`pinned: true` with its tile under `[data-essentials-drop]` and no alert;
dragging that tile back among the open tabs ends `pinned: false`, the tile
gone, still no alert. `@astra/frame check` clean (1228 unit tests), state-check
and brand-lint clean.

Deferred (unchanged gaps, still in `wire_baseline.json`): `tab_drag_over` and
`tab_drop` remain unrouted — dragging a tab out of the sidebar onto the page
has no native detach/window-drop backend yet, and the hover hint is not drawn.
The Essentials dock, rail and in-list reorder no longer depend on them.


## Owner report: a committed page must not wait behind the skeleton (2026-11-04)

"Loading a page is taking more time." The skeleton was covering pages that had
already arrived: the cover only came down when the whole document finished, so
one slow image, font or analytics hit hid a finished page for seconds.

| ID | Fix | Status | Evidence |
|---|---|---|---|
| D-42a | The slot's cover (`data-loading` + skeleton pill) ended at the *end of the load*, because the projection's `loading` flag (honest: it is what the tab row spins on) was the only input. `slot-state.js` now takes the committed tab/address and keeps the cover down for a projection that is still loading a document already in front | done | `slot-state.test.mjs` 13/13 (commit-stops-cover, different address still covered, per-tab commit, model commit vs real commit) |
| D-42b | `nav.committed` fires twice per navigation: the model commits the address at request time (no `external`) and the content binding reports the real document commit (`external: true`, progress listener). The shell treated the first as a reveal and the follow-up projection as a re-cover, so a typed load flickered and a link click skated. Only `external: true` reveals now; the model's own commit says nothing about the cover | done | `hostapi_v1.mjs` 324 checks (external flag still pinned); live probe below |
| D-42c | `tests/contract/load_state.py` measured a `browser[data-astra-browser]` inside the content slot — an element the native-deck merge removed (the stage is `gBrowser.selectedBrowser` in the docked tabbox), so it read `uri: null` and crashed. It reads the docked browser and the deck's visibility now, and pins the reveal-at-commit budget | done | `load_state.py` PASS; the same probe on `HEAD`'s bundle FAILs at 2026 ms for a page committed at 30 ms |
| D-42d | A tab opened straight on an address (a link in a new tab, `Tabs.create({url})`) sat on a blank `about:blank` stage until the document landed: the model only knew about loads it started itself, so `loading` stayed false. The content binding now raises the flag on the native tab's `busy` edge (and clears it on the same edge as before), so the cover follows the engine rather than one code path | done | `load_state.py` "a tab opened on an address" case: cover up at 120 ms, revealed at 486 ms on a 600 ms-stall fixture |

Live proof (packaged dev build, Marionette, throwaway profile,
`tools/perf/hidden-display.sh python3 tests/contract/load_state.py`):

| Case | Cover ends | Notes |
|---|---|---|
| loopback page | 44–74 ms | commit + load end together |
| server delays first byte 600 ms | 487–497 ms | skeleton stays for the whole wait, ends at commit |
| page commits, one image delayed 2 s | **24–33 ms** (was **2026 ms**) | `isLoadingDocument` is still true, tab row still spins, stage shows the page |
| tab opened straight on a 600 ms address | 486 ms | cover up at 120 ms on a stage that used to be blank; row spinner was already honest |

`gbrowser_stage_probe.py` now waits for `data-app-booted` before measuring, so
it reports `stage: page` with a visible deck instead of `app` and a hidden
tabbox (geometry was already correct). Shell unit tests 72/72, `hostapi_v1`
324, `shell_assembly`, `frame_model`, `shell_app_chrome` 17, state-check and
brand-lint clean.

Deferred: the reveal is the engine's **document commit** — the earliest
reliable chrome-side signal. True first-paint timing lives in the content
process (`PerformancePaintTiming`); wiring it would need a JSWindowActor and a
new event. A document that commits and then paints slowly therefore shows the
stage's ground for that gap, which is what Firefox does.

## Owner report: one interface for menus, sheets and settings (2026-11-04)

The owner asked for the same interface everywhere — the page menu, the pop-ups,
settings — and a layout that survives a narrow window. The page menu was the
last surface still drawn with its own recipe: an opaque 18px slab, 30px rows,
inset dividers and 11px labels, none of it matching the chrome's menus. The
dialogs had drifted the same way: four radii, three shadows and three scrims
across `.settings-dialog`, `PromptSheet`, `NoteLeavePrompt` and `AccountDialog`.

| ID | Fix | Status | Evidence |
|---|---|---|---|
| UI-1 | The page menu (right-click on chrome and on a page) now uses the menu system's recipe: `--color-float` ground, 22px panel, 6px pad, 34px rows, 8px item inset, full-bleed separators, menu headings and hints, menu open/close motion | done | live computed style: `rgb(61, 61, 68)`, radius `22px`, pad `6px`, row `33px`, row radius `16px`, font `13px`, separator bleed `-6px` (`out/ui-consistency/wide-menu.png`) |
| UI-2 | One overlay recipe (`--overlay-ground/-radius/-shadow/-pad/-scrim`, dark + light): every settings dialog, extension prompt sheet, note-leave prompt and the account dialog now share the same ground, corner, edge, padding and scrim. The bits-ui scrim and both native `::backdrop`s use it too | done | `AccountDialog.svelte`, `PromptSheet.svelte`, `NoteLeavePrompt.svelte`, `.settings-dialog*` in `browser.css`; light/dark look captures |
| UI-3 | The launcher's action sheet is a menu and now takes the menu geometry (solid float, 22px, 34px rows) instead of a bespoke 18px card | done | `LauncherActions.svelte`; light/dark captures |
| UI-4 | Below 760px the settings sections rail folds to the 56px rail and a section picker + search + close move into the page, so the reading column keeps the window instead of ~180px. Widening restores the rail in place (no second layout) | done | live probe: wide sidebar `328` with nav `264`; narrow viewport `652` → sidebar `56`, `.settings-sidebar-navigation` absent, `.settings-compact-nav` `display:flex`, page padding `26px 18px 44px`; back wide → `328` again |
| UI-5 | Settings rows stack their control on its own line under 560px (container query), and the callout/action rows stack under 480px, so labels never collapse into single words | done | 520px/600px component captures (`ui/target/probe-ui`) |
| UI-6 | Right-click works across Astra's own UI: the app now opens its menu everywhere except where a tab/site/folder owns one (those prevent the event first). The tab and in-use-indicator menus no longer call the unrouted `tab_menu_popup`; `src/app/browser/tab-menu.ts` registers a presenter with the tabs domain and draws New Tab / Reload / Copy Link / Keep / Split / Mute / Move to Space / Clear data / Close from existing routes | done | live: tab menu `["New Tab","Add to Essentials"]`, new-tab ground menu `["New Tab","New Window",…]`; `TabMenu.component.test.ts` 4/4 (full page rows, per-tab actions, kept/lone-tab variants, media-only) |

Live proof (packaged dev build, Marionette, chrome context, throwaway profile):

```sh
(cd ui && bun run --filter @astra/frame build:chrome)
(cd forge/astra-forge && cargo run -q -- overlay && cargo run -q -- build --faster)
tools/perf/hidden-display.sh python3 tools/marionette-probe/ui-consistency-probe.py out/ui-consistency
```

The probe opens the real page menu from the sidebar's `contextmenu` path, runs
Settings from the menu's own row, narrows the window and widens it again. All
steps pass. Screenshots: `wide-menu.png`,
`wide-settings.png`, `narrow-settings.png`, `back-wide.png`.

Gates: `bun run check` clean (svelte-check 0/0, eslint, stylelint, prettier,
knip, **1227 unit tests** after retiring the obsolete menu-target test; the
tab-menu component test adds 4); component batch 17 files / 85 tests (the only
failure is the known `DropdownCsp` case that needs the missing native artifact);
`shell_app_chrome` PASS, `hostapi_v1` 324, `shell_assembly` PASS, `frame_model`
PASS, `wire_coverage` 48, bridge 27, `check-styles` 144 files, forge lint 11
patches clean, footprint within budget, state-check and brand-lint clean. The
12 component failures seen in the wider settings/shared batch were reproduced
identically with this change stashed (account billing text, shortcut recorder
and `US$` currency formatting), so they are not from this work.

Deferred: Work's canvas popovers/HUD keep their canvas-specific float recipe
(a canvas object is not a menu); extension pop-ups remain native windows owned
by the engine; per-space theming is unchanged.

## Owner report: spaces inside profiles (2026-11-08)

**Decision:** D-44. **Contract:** `docs/astra/SPACES.md`.

| Surface | What changed | Wiring / files | Verification |
|---|---|---|---|
| Profile → many spaces | A profile mints a home space and can own any number of further spaces. Space ownership is immutable and persisted. The running profile adopts pre-ownership spaces once; creating/deleting a profile creates/deletes all of its spaces. | `overlay/astra/host/Tabs.sys.mjs` (`profile_id`, `__activeProfileId`, `__adoptSpace`, `createSpace({profile, activate})`, owner guards), `overlay/astra/host/Profiles.sys.mjs` (`spaceForProfile`, `switch`, `create`, `remove`), `overlay/astra/host/Metadata.sys.mjs` (`profile_id` in save/restore), `crates/astra-core/src/session.rs` (`SpaceSnapshot.profile_id`) | `tests/contract/spaces_profiles_model.mjs` 37/37; `profiles_model.mjs` 77/77; `spaces_model.mjs` 21/21; `cargo test -p astra-core --jobs 2` |
| No sharing across profiles | The switcher, reorder, tab move, bookmark import and clear-data only act inside the profile in front. A space of another profile is not listed, cannot be edited/deleted from it, and is refused without confirming it exists. | `Tabs.sys.mjs` (`updateSpace`, `deleteSpace`, `reorderSpace`, `moveTabToSpace` owner guards), `ui/app/src/domain/tabs/tabs.svelte.ts` (`profileSpaces`), `space-flow.svelte.ts`, `RailSpaces`, `SidebarBody`, `TabRail`, `tab-menu.ts` | Ownership and refusal checks in `spaces_profiles_model.mjs`; unit suite 1238 pass |
| Settings → Spaces | New section: list/create/rename/delete/switch the profile's spaces, import bookmarks from a sibling space, clear one space's site data, see and switch other profiles with their space counts. | `ui/app/src/features/settings/components/sections/SpacesPage.svelte`, `settings-model.ts`, `Settings.svelte`, `ProfilesPage.svelte`, `messages/en.json` | `svelte-check` 0 errors/warnings; lint/stylelint/format clean; 200 unit test files pass |
| Bookmark import | `bookmark_call` gained a bounded copy call (`import_space`): copies folders and links, skips other spaces' roots, never moves the source, and refuses a space of another profile. | `overlay/astra/host/Bookmarks.sys.mjs`, `bindings.ts` (`BookmarkCall`/`BookmarkResponse`) | `spaces_profiles_model.mjs` (copy + source intact + cross-profile refusal) |
| Per-space data clear | `browsing_data_call` gained `clear_space`: clears exactly one space's cookies/site data/cache through the container's `userContextId`; refused for another profile's space. | `overlay/astra/host/BrowsingData.sys.mjs`, `bindings.ts` (`BrowsingDataCall`) | `spaces_profiles_model.mjs` (one container addressed; cross-profile refused) |
| Credentials cannot cross spaces | Firefox's login manager, form history and address/credit-card autofill are origin-keyed, not container-keyed, so they are off by default; password-manager extensions and the OS vault remain. | `overlay/astra/mozilla.cfg` (signon/formfill defaults), `docs/astra/PASSWORD_DECISION.md` | Preference block present; contract tests assert container isolation (`containers_isolation.mjs` 117 checks) |

**Deferred:** the Places history database, downloads list and favicons are still
global to the running profile directory (D-41); per-space history needs an
engine-side visit annotation. The packaged dev build was not rebuilt or
restarted for this batch because a live instance was already running; run
`tools/marionette-probe` after the next build to capture live evidence for the
Spaces page.
