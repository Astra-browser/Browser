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

## Owner report: the Now playing card was title-only (2026-11-21, branch `fix/media-now-playing-card`)

The owner reported that the sidebar card showed only a correct title: no
thumbnail, controls that did not appear to act, no mute state, and no way to
control a second site playing at the same time. The rail's media entry showed a
generic note, the page host and no site mark.

| Surface | What changed | Files |
|---|---|---|
| Card plate | The card's left plate is the page's own Media Session artwork when it publishes any (fetched and rasterised in chrome to a 96px WebP data URL), else the tab's site mark. The rail's media trigger and every list row use the same mark. | `overlay/astra/host/Content.sys.mjs` (`pickArtwork`, `rasterArtwork`), `features/media/components/MediaPlayer.svelte`, `features/rail/components/UtilityBar.svelte` |
| Live transport/status | `icon` was hard-coded to `null`; it now comes from the tab projection. Play, pause and mute were already routed, but the projection never carried the site mark, and a later event could overwrite the card with an entry whose fields disagreed. `sameView` now also compares `icon`, `artwork` and the other-player list, so a change is emitted exactly once. | `overlay/astra/host/Content.sys.mjs`, `overlay/astra/host/Media.sys.mjs`, `domain/media-player/player.svelte.ts` |
| Several players | The projection carries `players`: every other live media tab in the window, each with its own title, mark, playing and muted state. The card's expanded area lists them with play/pause and mute; the rail lists all of them with the same controls. Actions are addressed to the row's own `tab_id` through the existing `media_player` route, so no second transport exists. | `Content.sys.mjs`, `Media.sys.mjs`, `MediaPlayer.svelte`, `UtilityBar.svelte`, `shared/ipc/bindings.ts` |

**Wire note (SCOPE rule 5):** `MediaPlayerView` gained two additive optional
fields — `artwork?: string | null` and `players?: MediaPlayerEntry[]` — plus the
`MediaPlayerEntry` type. The Rust Specta source that generated `bindings.ts` is
no longer in this tree (the Tauri host is gone), so the fields are recorded
here and added additively to the checked-in generated type; no command, route or
event name changed. `tests/contract/media_model.mjs` pins the shape and the
change detection (67/67).

**Verification:** `node tests/contract/media_model.mjs` 67/67;
`typecheck` 0 errors; MediaPlayer, UtilityBar and RailPlayer component suites
36/36; `tools/marionette-probe/media-card-probe.py` **20/20 PASS** on the
packaged Windows dev build — it drives two real pages with Media Session
artwork and asserts the artwork reaches the card and the rail, card
play/pause/mute change the engine, both players are listed, and each row's
play/pause and mute act on its own page. `now-playing-probe.py` was reading the
default window key after the per-window media split; it now asks the window it
opened and is **PASS** again (the probe was failing for that reason, not the
product). `state-check` and `brand-lint` are clean.

**Still deferred:** YouTube's own player was not driven; the probe uses local
pages that publish the same Media Session metadata and handlers. A page that
publishes no artwork falls back to the tab's site mark.

## Owner report: the ad blocker stopped working after a refresh (2026-11-22, branch `fix/blocker-refresh-consistency`)

**Symptom:** on YouTube (and sites that rely on scriptlets) an ad played after
refreshing the page, and sometimes on the first visit, while the shield read
active and the blocked counters advanced. It looked random between tabs.

**Cause (three stacked defects in the page half; the network half was fine —
YouTube serves ad and content media from the same `videoplayback` endpoint):**

| Layer | Why it failed | Fix |
|---|---|---|
| Scriptlet harness | adblock-rust ships the uBO scriptlet bodies but not the `scriptletGlobals` object they read. Every scriptlet threw inside adblock-rust's own `try { ... } catch {}` and did nothing, silently, on every site. | `overlay/astra/actors/AstraBlockerProcess.sys.mjs` prepends a harness prelude (`scriptletGlobals`, page-realm aliases). |
| Page realm | The payload ran in a chrome sandbox: traps landed in the WindowProxy's Xray expando (invisible to page scripts) and `value instanceof Object` was false for page objects, so nested chains such as `ytInitialPlayerResponse.adPlacements` were never trapped. | The prelude binds `window`, `self`, `globalThis` and the standard constructors to `window.wrappedJSObject`, the page's own inner window. |
| Document timing/lifecycle | The lookup ran from the per-document window actor (`DOMWindowCreated`), which a freshly spawned content process can create too late; per-document state could also survive a document change. | A long-lived process actor (`ChromeUtils.registerProcessActor`) receives the payload the Host computes at `http-on-modify-request` and injects from `document-element-inserted`, before the first script, once per document. The Host warms the process actor at install and broadcasts on a cross-site first navigation. `#releaseDocument` resets every document-scoped field on a document change; `pageshow` stays as the late-actor/bfcache fallback. |

**Verification:** `blocker-refresh-probe.py` **32/32** on the packaged Windows
dev build (first load, three reloads, a second and third tab, switch-back: CSS
via agent sheet, scriptlet visible to the page's own inline scripts, nested
chain trapped, zero ad-image requests); `youtube-ads-probe.py` real watch page:
before the fix an ad played after reload (10-17 of 30 one-second samples), after
the fix **0 ad samples** on first load and three reloads, with
`ytInitialPlayerResponse.adPlacements` pruned where the hand-off landed before
the inline response; `blocker_coverage` **29/29**, `blocker_host` **97/97**,
`blocker-probe.py` PASS; `state-check` and `brand-lint` clean; overlay staged
and `forge build --faster` clean.

**Still deferred:** a rare navigation that commits without the request-time
hand-off falls back to the async lookup at `DOMContentLoaded`, which installs
the scriptlet after the document's first inline response. Removing that last
case needs a content-script-style preload hook in the engine, not a JS actor.

## Owner report: a sign-in popup opened as a full Astra window (2026-11-21, branch `fix/popup-windows`)

**Symptom:** a site that signs in with `window.open(url, name, "width=520,height=640")`
(Canva, Atlassian) opened a full Astra window: the product shell (column, tab
row, address field) appeared, the window filled the screen, and it looked like
a second browser instead of the engine's small popup. The owner's reference is
Chrome/Firefox: a titlebar, the URL bar the site asked for, the requested
window size, and `window.close()` at the end of the flow.

**Cause (three stacked defects):**

| Layer | Why the window was wrong | Fix |
|---|---|---|
| Shell | `browser.xhtml` mounts the Astra shell in every chrome window, popups included, so the product chrome replaced the engine's reduced popup chrome. | `ui/shell/src/main.js` asks `isPopupWindow(window)` (`ui/shell/src/popup.js`: hidden toolbar, or `chromehidden` carrying `toolbar`/`location`); a popup gets `data-astra-popup`, its `#astra-root` is removed and the Svelte shell never mounts. `shell-chrome.css` only hides the native chrome on non-popup windows, so the native titlebar/URL bar and content deck answer. |
| Engine geometry | The popup restored the browser window's persisted size, position and size mode before `nsWindowWatcher` applied the features, so a 520x640 request became the main window's geometry. | `patches/ASTRA-0021`: a content-created chrome window with no toolbar or location bar ignores XUL persistence (`mIgnoreXULSize`/`Position`/`SizeMode`). |
| Engine sizing | On the fresh popup the primary content element had no layout yet (`0x0`), so the chrome/content difference was the whole window; the security clamp then expanded the requested inner height to the work area. `SetPrimaryRemoteTabSize` also added the whole request to the current window. | `ASTRA-0021`: treat a zero-sized primary content as "not laid out" and size the shell directly instead of by delta; do not count an unlaid-out content area as chrome. |

**Result on the packaged Windows dev build:** the popup is 534x678 outer with
a **520x640 page viewport** at the requested position, no Astra frame, root or
adoption, the native deck visible, and `window.close()` from the page removes
the window while the browser window survives.

**Follow-up (same day): 0.1.767 regressed window restore and the page stage.**
The installed 0.1.767 opened the owner's profile as a **514x127 strip** (the
session's stored geometry) and the page area stayed black. Two separate
regressions, both now fixed on `fix/popup-windows` and shipped as 0.1.768:

| Regression | Cause | Fix |
|---|---|---|
| A normal window restored to its session size (514x127), unusable | The new popup sizing fallbacks were not scoped: `SetPrimaryRemoteTabSize`'s zero-content fallback also ran for session-restored windows, and `SizeOpenedWindow`'s unlaid-out-content rule applied to chrome callers, so the stored size was finally honoured. | `ASTRA-0021` now marks content-created windows (`mContentCreated`) and only those take the zero-content fallback; the `chromeWidth=0` rule is gated on `!aIsCallerChrome`. Browser/session windows keep the previous path; the dev build and 0.1.768 open the same profile at 1511x791. |
| The page area was black although the tab and title loaded | The popup-hide selector used `:root:not(...):not(...) :is(#tabbrowser-tabbox...)`, raising its specificity above the shell's `:root[data-astra-gbrowser] #tabbrowser-tabbox` dock rule. Both were `!important`, so the native deck stayed `display:none` (`0x0`) and only the empty `.astra-content` slot showed. | `shell-chrome.css` hides with `:root:where(...) :where(...)`, so the dock rule outranks it again. Contract pins the `:where` form. |

**Verification:** `popup-window-probe.py` **20/20** on the dev build and on the
installed 0.1.768 `astra.exe`; `version-probe.py` **8/8** (About 0.1.768);
`native_surfaces.mjs` **142/142** (the new specificity check included);
`ui/shell/src/popup.test.mjs` **6/6**; `forge lint` 21 patches clean;
`state-check` and `brand-lint` clean. Live proof on the installed 0.1.768 with
the owner's profile: the window opens at 1511x791, a local marker page paints
(deck/slot/browser rects all `276,8,982,777`, `elementFromPoint` = `browser`),
Canva loads from the address field, and the screenshots are in the run log.
`patches/ASTRA-0021-astra-popup-geometry.patch` is the only engine change and
`forge overlay` applies it on a fresh `forge fetch`. The probe is registered in
`tools/perf/full-suite.sh` and `.ps1`.

**Still deferred:** none for this surface.

## Owner report: the put-away column's card has no address bar (2026-11-21, branch `fix/sidebar-card-address`)

**Symptom:** with the column put away, reaching the left edge brought the card
out with its utilities and tab list but without the page controls (Back,
Forward, Reload, Home) or the address field. Over a live page the page bar is
floating and hidden, so the window had no address bar at all until the pointer
reached the very top edge.

**Cause:** `sidebarOwnsBar` asked only `isHidden()`. The card a put-away column
slides out as is still the column and draws its head from the same `nav` and
`field` snippets, but the shell handed both to the stage bar, which is hidden
over a live page. `ffd89c5e` had fixed exactly this headless card; `dcdde4f1`
reintroduced it when the field was pinned to the column for every bar mode.

**Fix:** the sidebar session publishes whether the column or its card is on
screen (`sidebarCardShown`, set from `away`/`peeking`). `sidebarOwnsBar` pins
the page controls and the one address field to the head whenever the full
column is shown, including the peek card; the bar keeps the field only while
the column is genuinely away, so the top-edge reveal still works.

**Files:** `app/browser/Shell.svelte`,
`features/sidebar/components/Sidebar.svelte`,
`session/sidebar-mode.svelte.ts`; test
`app/browser/tests/SidebarCardHead.component.test.ts`; live
`tools/marionette-probe/sidebar-card-head-probe.py` (registered in both
`full-suite` launchers).

**Verified:** `SidebarCardHead` component suite **1/1 PASS**: while the card is
out the head carries the page controls (six buttons: Back, Forward, Reload,
Home, the column's options and the way back) and exactly one address field, and
the bar keeps none; when the card goes away the field returns to the bar and
the head drops it. `sidebar-card-head-probe.py` repeats it live on the packaged
dev build (real page, real edge reveal): away
`{headField:false, barField:true}`, peeked
`{headField:true, headNav:6, barField:false, count:1}`, back
`{headField:false, barField:true, count:1}`. `eslint` and Prettier are clean on
the touched files; `build:chrome` staged 811 files with a clean CSP audit.

## Owner report: a hairline strip left of a live page (2026-11-21)

**Symptom:** on a live page (never on Home) a thin line ran down the left edge
of the page. After a hidden column peeked out and went back, the same narrow
strip beside the page still looked drawn, as if the column's edge had stayed
behind.

**Cause:** with the column away, the app hands its page the window's 8px gutter
(`ui/app/src/styles/browser.css`: the page's inset from the column and the
`.stage-card` start both go to 0), but the shell kept the native stage at
`column + 16px` — the 8px gap that only exists beside a visible column. The
app's page card (edge, 0.5px ring and drop shadow) therefore painted 8px left
of the real page: that was the line, and the strip a peeking card seemed to
leave. Home was unaffected because the app's own page and its card shared the
gutter; only the native page was a gap too far right.

**Fix:** `ui/shell/src/Shell.svelte` puts `.astra-content` on the same 8px
gutter whenever `data-astra-sidebar-hidden` is set, so the native page, the
app's card and New Tab share one left edge. The rule carries the same
`[data-app-booted]` weights as the base rule that sets `column + 16px`;
without it the base won on specificity. A peek still never moves the page, and
the top edge keeps the floating-bar rule unchanged.

**Verified:** packaged Windows dev build (`overlay` + `build --faster --jobs 2`),
local page, `ui.main-bar=auto`, live Marionette readings:

- column in view: page / card / native deck all at x=276 beside the column;
- column away: page x=8, card x=8, deck x=8 (was 16 / 8 / 16), page top 8;
- peek: card out at x=8, page still x=8; after it goes back page and card are
  both still x=8 and no card edge is left in the strip;
- New Tab with the column away: pane x=8 — Home and live pages share the edge.

Screenshot pixel columns confirm the old 8..16 band (app card edge and its
drop over the window ground) is gone; the page now starts on the gutter.
`tools/marionette-probe/sidebar-strip-probe.py` pins those four states and is
registered in both full-suite manifests (17/17 PASS against the live build).

## Owner report: upgrade shows "Firefox is already running" (2026-11-21)

**Symptom:** after installing a new build, a native Firefox dialog said the old
process was not responding and must be closed.

**Cause:** two Windows launch paths used `-no-remote` on the live profile:

- every shortcut, ProgId command and the installer's "Launch Astra" passed it,
  so a second launch could never hand off to the running instance and fell
  through to the engine's profile-lock dialog;
- the installer's headless warm-up also opened `%APPDATA%\Astra\Profiles\default`
  while the person's Astra was running, so a silent upgrade could leave a
  blocked headless process holding the dialog.

**Fix:** the installed and portable launch paths no longer use `-no-remote`
(a second launch now opens a window in the running instance and exits), and the
warm-up uses a throwaway `%TEMP%\astra-warm-profile` with `-no-remote`, removed
afterwards. `astra.cmd`, the README, shortcuts, ProgId commands and the finish
page all agree. The dev launcher keeps `-no-remote` because it owns a separate
dev profile.

**Verified:** 0.1.765 installer runs silently to completion while a live Astra
0.1.764 instance is open, with no warm-up process left and no dialog; shortcuts
and ProgId commands contain no `-no-remote`; the live version probe reads
0.1.765.

## Owner report: a tab click did nothing after the window sat hidden (2026-11-21)

**Symptom:** after the window stayed in the background for a while (or after a
profile/space switch), clicking the tab that was already in front sometimes did
nothing. Choosing another tab and coming back recovered it. The page itself was
painted, so the tab strip, the model and the visible document disagreed rather
than the load failing.

**Root cause:** the native tab deck (`#tabbrowser-tabpanels`) and the engine's
selected tab (`gBrowser.selectedTab`) can drift apart when a switch is
interrupted, a tab is moved under a pending switch, or the window returns from
an occluded/hidden period. Astra's click path re-sent the same selection, but
the tabbrowser treats that as a no-op: `MozTabs.selectedItem` skips
`selectedIndex` when the item is already selected, so no `TabSelect`, no
switcher request and no deck update followed. The host's activation pass only
made the browser's docshell live; it never asked the deck to show the selected
panel, so the only way out was a real switch to another tab and back.

**Fix:** `overlay/astra/host/Content.sys.mjs`:

- a `presentSelected()` repair runs when a model selection names the tab the
  engine already has: it shows that tab's panel on the deck when the tab has
  presented before (a tab that never presented keeps its own load path);
- the same repair plus the tab's activation pass runs on the window's
  `activate` and on `visibilitychange`, so returning from another app puts the
  page back without any tab switch;
- both listeners are removed on detach. The pure decision is exported as
  `needsDeckRepair()` and pinned by the contract.

**Verification:** `node tests/contract/tab_lifecycle.mjs` **21/21** (four new
deck-repair cases); `tabs_admission` **14/14**, `window_scope` **24/24**,
`spaces_profiles_model` **39/39**, `state-check` clean; overlay staged and
`forge build --faster --jobs 2` clean. New live
`tools/marionette-probe/tab-reassert-probe.py` **7/7** on the Windows dev build:
with the deck forced onto another tab, re-selecting the tab is proven a no-op
in the engine, the real Astra tab-row click puts the panel back, and a window
`activate` repairs the same drift without a click. The probe is registered in
`tools/perf/full-suite.sh` and `tools/perf/full-suite.ps1`.

## Split view flow: picker, drag-to-tab, independent splits (2026-11-21)
## Owner report: the address bar stays in the column, and links open directly (2026-11-21)

The owner asked for two things: the address/search bar that lives in the
sidebar must remain there whatever the page bar is doing (pinned, auto, hidden
or revealed by a top-edge hover), and a typed link — `http://localhost:3000`,
`localhost:3000`, a bare host, any `http(s)` address — must open directly
instead of being searched on the engine. Every other query keeps going to the
search engine.

| Surface | What changed | Files |
|---|---|---|
| Address field home | `sidebarOwnsBar` no longer depends on the platform or on `ui.main-bar`: while the column is in its full shape and in view, the column's head owns the one field. On Windows the page bar stays in the tree as the window-controls strip only; `ContentBar` now takes an optional `field` and `nav`, so the same bar can carry the field elsewhere (rail, panel, column put away). | `app/browser/Shell.svelte`, `features/toolbar/components/ContentBar.svelte` |
| Typed links | `Search.newtabSearch` and `Search.launcherSearch` resolve the typed line first: an address answers with one `url` row (`Open <address>`) and asks no suggestion provider; words/`!bangs` keep the search row and the provider. The surfaces' Enter takes the address-bar route immediately for an address (`looksLikeAddress`), so a settled or stale row can never hand a link to the engine. | `overlay/astra/host/Search.sys.mjs`, `features/search/lib/search-surface.svelte.ts`, `shared/lib/address.ts`, `features/address/components/AddressField.svelte` (suggestion suppression uses `hasScheme` + `looksLikeAddress`) |
| Speed | An address skips the 80 ms suggestion debounce, the provider request and the row round trip: the field opens it at once. Word searches are unchanged. | same |

**Verification:** `node tests/contract/search_model.mjs` **71/71** (new checks:
a typed address answers with one `url` row, no provider is asked, and words
still search); `shared/lib/tests/address.test.ts` 5/5; `NewTabSearch` 8/8 (new:
a typed address opens directly, not through the engine); `ContentBar` suite
23/23 together with `NewTabSearch`; `svelte-check` 0 errors / 0 warnings; full
unit suite 1278 passed / 2 skipped. `ShellA11y`, `TopPanelControls` and
`SitePanel` were updated to pin the new home of the field. Live Marionette on
the packaged Windows dev build
(`tools/marionette-probe/address-home-probe.py`) **PASS**: the column's head
carries the one field with `ui.main-bar` set to `always`, `auto` and `hidden`
and with a top-edge hover, the page bar never owns it in that shape, and typing
`localhost:3000` committed `http://localhost:3000/` — no Google search.

**Still deferred:** nothing for these two surfaces. `WindowsChrome`'s acrylic
body-wash assertion fails on this machine (`rgb(31, 31, 34)` vs `28%`); it is a
material-token check untouched by this change.

## Split view flow: picker, drag-to-tab, independent splits (2026-11-21)

The owner reported that **Open in Split View** in a tab's menu did nothing, and
asked for a chooser, tab-on-tab dragging, a way out of a split, several
independent 2–3 pane splits, and no reload/resize or resource cost. The branch
was merged on the owner's instruction after the checks below.

| Surface | What changed | Files |
|---|---|---|
| Open in Split View | The row now opens Astra's picker instead of splitting blindly with the selected tab. The picker names the right-clicked tab, lists the tabs that can join it, and offers a blank "New tab" pane. Both actions send `source` + `other` (or `pane` + `about:blank`) so the right-clicked tab is always the pane in front. | `session/split-picker.svelte.ts`, `features/split/components/SplitPicker.svelte`, `tab-menu.ts`, `Shell.svelte`, `domain/tabs`, `shared/ipc/surfaces.ts` |
| Drag a tab onto a tab | Dropping on the middle half of another tab pairs the two into a split; the top/bottom quarters still reorder. New setting **Drag a tab onto a tab to split** (`split.drag-tab`, on by default) turns only this gesture off; dragging to the page edge is unchanged. | `features/tabs/lib/split-drop.ts`, `TabList.svelte`, `TabRail.svelte`, `session/row-drag.svelte.ts`, settings catalog + Tabs page |
| Leave a split | Each pane row has a detach control ("Open in its own tab"); dragging a pane out still works. The detached tab becomes the ordinary tab in front, its page is not reloaded, and the remaining panes keep their exact shares. | `TabRow.svelte`, `SplitGroupRow.svelte`, host `leave`/`expandSplit` |
| Several splits | Each split is independent and capped at 3 panes (or the configured 2). A parked split whose card changes now reaches the sidebar immediately: `refresh` emits when `split_groups` changes, not only when the active group does. A tab outside a split can start another one; a full split says "Split view full" and never steals a pane. | host `SplitView.sys.mjs` (`refresh`), picker capacity model |
| No reload / no resize | Only panes that were blank before a split are warmed. A tab that already had a page is moved into the split and never re-requested; a busy tab is not re-loaded by the retry. Adding a pane rebuilds the wrapper in one turn instead of `TabTabs.addTabs`, preserving both the browser and every pane share. Server request counts prove the source page is fetched once across split, detach and re-split. | host `SplitView.sys.mjs` (`isBlankTab`, `tabBusy`, `warmPanes`, `expandSplit`, `sharesForRemaining`) |

**Stacking:** a tab menu handing over to the picker kept `popupRaised` true,
so after the menu's own `menu-close` the shell never received a second
`menu-open`; the frame stayed under the native page, its backdrop blurred the
app, and the page covered the dialog. The raise now tracks the popup element
(not just a boolean), so the handover re-raises the frame. The probe asserts
`data-astra-menu-open` and `data-astra-raised` after the menu closes.

**Verification:** `tools/marionette-probe/split-view-probe.py` **30/30 PASS** on
the packaged Windows dev build (local server pages, real app UI): the menu row
opens the picker, the right-clicked tab is the source, server hits are 1 for a
page carried through split/detach, two extra splits stay separate with their own
cards, a third pane is accepted, a fourth row is disabled, detach leaves the
tab in front with no handles, drag-to-tab works with the setting on and not with
it off, `split.enabled` removes/restores the row, `split.max-panes=2` makes a
2-pane split full, and cleanup leaves 0 split wrappers and 0 resizers. Unit
suite **1273 passed / 2 skipped**; new `SplitPicker` 3/3, `TabReorder` 9/9
(including tab-on-tab and the off gesture), `split-drop` 5/5;
`native_surfaces` **138/138** (new picker/setting/URL/share checks); typecheck,
eslint and knip clean; `build:chrome` staged 810 files with a clean CSP audit;
engine `build --faster` green. The full `bun run check` stops on a pre-existing
stylelint error in `WindowControlsInline.svelte:76` (a `7px` radius, untouched
by this branch); the touched styles pass stylelint and Prettier.

**Still deferred:** `split.restore`/`remember-width`/`double-click-reset`/
`drag-edge` and group settings keep their existing host/UI coverage rather than
a second live pass here. The picker is drawn in the app frame; the shell raises
that frame through the existing dialog detector.

## Owner report: a fullscreen video had an invisible wall over it (2026-11-20)

Fullscreening a video on any site (YouTube reported) put an invisible,
transparent sheet over the page: the pointer never reached the video, so its
own controls never appeared on hover and a click did nothing.

| Symptom | Cause | Fix |
|---|---|---|
| Fullscreen video ignores hover and clicks, chrome still looks gone | The content slot `.astra-content` is only the rectangle the native tab deck is docked over. The DOM-fullscreen rule raised that empty, transparent slot to `z-index: 10` "so the page fills the window", but the deck paints at `z-index: 2`; the slot therefore sat above the page across the whole window. It is transparent, so the video stayed visible, and it takes the pointer, so the page received nothing. | `shell-chrome.css`: in DOM fullscreen the slot stays under the deck (`z-index: 0`) and is out of hit testing (`pointer-events: none`). The deck owns the window; the slot is a passive rectangle. |

**Evidence before/after (dev build, real DOM fullscreen from a page
`requestFullscreen()`):** before, `document.elementFromPoint` at the centre
and all four edges returned `.astra-content`, and a synthetic move never reached
the page. After, every sampled point returns the page browser (inside
`#tabbrowser-tabbox`), and the page records the move and the click; the app
frame is `display: none`, the stage rect is `0 0 1536 864`, and leaving
fullscreen restores the normal stage and the page's pointer.

**Verification:** new `tools/marionette-probe/fullscreen-probe.py` **12/12**
PASS on the Windows dev build (enters DOM fullscreen, stage fills the window,
no chrome above the page, slot `pointer-events: none`, hover + click reach the
page, exit restores the window); registered in `tools/perf/full-suite.sh` and
`tools/perf/full-suite.ps1`. `tests/contract/native_surfaces.mjs` now pins the
rule (slot under the deck, no pointer) — **128/128**. The probe drives a local
HTML page, not YouTube itself; the layering it proves is site-independent.

## Owner report: DevTools opens as a sliver (2026-11-20, branch `fix/devtools-window`)

The owner reported DevTools as "laggy, unresponsive" on YouTube and said the
DevTools window itself was the slow part. Measured first on the installed
0.1.758 with a copy of the owner's profile (their last YouTube tab), because a
wrong fix here would hide the real cost:

| Measurement (DevTools open) | Result |
|---|---|
| Toolbox window appears / ready | 162–229 ms / 0.4–0.9 s |
| Chrome main-thread rAF, idle and settled | 59–60 fps, no long tasks |
| YouTube video, DevTools open | 0 dropped frames / 856 |
| Console, Inspector, Network, Debugger + scrolling | max 168 ms frame gap, no ≥250 ms stall |
| Toolbox window's own rAF (both 322 px and 713 px tall) | 59.9 fps |
| OS window ping (`WM_NULL`, browser + toolbox) | ≤2.2 ms, 0 hung replies |

The lag itself did **not** reproduce: the chrome is idle while DevTools is open
and the toolbox renders at 60 fps. What was genuinely broken is the window:
`toolbox-window.xhtml` is **900x320** and `persist`s that size, and Astra always
uses the window host (the native tabbox is hidden). The owner's profile was
stuck at **1250x322**, with the inspector sidebar taller than the window.

**Fix:** `ui/shell/src/content-menu.js` now gives the toolbox a usable size and
position when it opens (`devToolsWindowRect` / `placeToolboxWindow` /
`scheduleToolboxPlacement`, all pure except the two window calls):

- a degenerate window grows to at least 760x420 and up to 72%×62% of the
  browser window (900–1400 px wide, 560–1000 px tall), centred over it and
  clamped to the work area;
- a usable size the person set is never touched (and an off-work-area window is
  only moved);
- placement is re-checked for 6 s because XUL restores the persisted size and
  ignores resizes until the toolbox has loaded; the first open of a session
  also imports the DevTools modules.

**Verified:** `node --test ui/shell/src` **86/86**; `tools/marionette-probe/devtools-window-probe.py`
**6/6** against the installed build (fresh profile: 900x320 → 932x560 centred;
reopen stable; a 900x300 sliver grows back; a person's 1000x700 at 60,60 kept);
the owner's real profile: **1250x322 → 1250x560** centred over 1511x791.
The shell bundle was rebuilt (`build:chrome` path unchanged) and prettier is
clean on both touched sources.

**Deferred:** the owner's lag report itself needs a retest on this build. If it
returns, the probe to extend is `devtools-window-probe.py` (add panel switches
and console typing); the numbers above are the baseline it must beat.

## Owner report: window ground colour on click + the unreachable page bar (2026-11-20)

Two owner reports from the Windows dev build, both traced to chrome layers
rather than to the app's own surfaces.

| Symptom | Cause | Fix |
|---|---|---|
| Clicking anything turned the whole window's ground (the 8px gutter and every translucent edge) into the desktop's colour, and it only happened once the window was in use | The material tiers painted the window ground as a translucent wash (`color-mix(chrome 20–28%, transparent)`), so the OS backdrop showed through it. Windows only wakes the Mica backdrop for the focused window, so the shift tracked focus. | `material.css`: mica and acrylic paint the window ground in the theme's own `--color-chrome`. The wash still tints menus, the launcher and raised floats; the desktop hue no longer belongs to the window. |
| The top bar never appeared, hover or not; the address field had no home on a web page | The window's top gutter was a 16px XUL caption box (`-moz-window-dragging: drag`). On Windows that box is a `HTCAPTION` hit-test: the OS owns the pointer there and no `pointermove`/`pointerenter` ever reaches a document, so the reveal strip underneath could not fire. | The caption box is now the gutter's own 8px, and the shell hands that gutter to the reveal strip whenever the bar floats (the caption stays while the bar is a row). The reveal strip itself is no longer a drag region. |

**Verified:** `WindowGround` (new, 4/4: opaque ground for mica/acrylic in both
themes), `BarHover` (2/2), `ShellLook`, `NewTabMaterial` component suites; the
chrome bundle and the shell rebuilt into `overlay/astra/chrome/`
(`stage-chrome`: 802 files, CSP audit clean); stylelint and prettier clean on
the touched sources.

**Follow-up, same day — a sliver of chrome over the page.** The bar's hold
could latch: a `pointerleave`/`focusout` that never fires (pointer out through
the window edge, a native page taking the press, another app forward) left the
bar "hovered" for good. The shell then kept the whole app frame raised and
clipped over the page, so a strip of chrome at the window's edge was live
compositing for a bar nobody had asked for. Two changes:

- `Shell.svelte` (app): the hold is dropped on the document's own `blur` and on
  `visibilitychange → hidden`. Nothing inside a document that lost the pointer
  and the focus can still be holding its bar (`BarHover` 3/3, new test).
- `Shell.svelte` (shell): with the column put away the raised frame's kept-left
  region collapses to zero. It used to leave 16px of the app frame down the
  left edge, painting chrome over the page under the bar's strip.
  Live: column hidden + a page + the bar revealed now clips to
  `polygon(0 0, 100% 0, 100% 49px, 0 49px, 0 100%, 0 100%)` (`keep-left: 0px`);
  before it kept a full-height sliver.

**Deferred:** a live Windows probe of the reveal at the window edge and of the
pinned bar's paint over a native page; the bar is not a drag surface while it
floats (drag it once it is down, or from the window's other edges).

## Owner report: splash / startup speed (2026-11-19)

Startup was measured from the real window (Win32 `PrintWindow` frames every
~200 ms, independent of Marionette) and with the shell/app boot marks. On the
installed 0.1.753 build the splash was still up at 3.7 s and the first usable
chrome appeared between 3.7 s and 4.7 s.

| Finding | Evidence |
|---|---|
| The app document itself is fast | navigation 157 ms, DOMContentLoaded 157 ms |
| The shell mounts at ~0.65–0.9 s and starts the app frame ~90 ms later | `data-boot-start` / `data-boot-frame` |
| The app mounts at ~0.14 s of its own timeline, then its first section paint waited 0.6–0.9 s | new marks `astraEntry` / `astraMounted` / `astraItems` / `astraSections` |
| The shell answered the app's first `Tabs.bootstrap` in <1 ms — when it got to the message | relay marks `astraRelayReq` / `astraRelayRes` |
| A chrome-process profile showed 0.26 s bursts in engine `utilityOverlay.js` and a 0.46 s first layout (`getBoundingClientRect` → `PresShell::DoFlushPendingNotifications`) on the main thread | Gecko profiler + local PDB |

**Changes landed (0.1.754):**

- The app entry now stamps `astraEntry`, `astraBridge`, `astraMounted`,
  `astraItems`, `astraBar`, `astraRow`, `astraEssentials`, `astraShelf`,
  `astraSections` and `astraBootstrap`, and the shell stamps
  `astraRelayReq`/`astraRelayRes`. These are cheap dataset writes and make the
  next startup regression measurable.
- The first projection is asked for again (60/150 ms retries) instead of
  waiting for an unrelated host event; the reveal ceiling is 600 ms, so a lost
  first event can no longer hold the splash for 1.2 s.
- The shell waits (bounded 400 ms) for the app's first paint before it starts
  the native deck mount, so adoption work cannot starve the relay that answers
  the app's first projection.
- `Frame.sys.mjs` is imported after that first paint. Its synchronous module
  evaluation was on the path between the app mount and the first projection;
  `__astraHost.Frame` is now a lazy getter and the window controls no-op only
  for the brief moment before the import completes.

**Result:** first usable chrome at **3.4–3.8 s** instead of 3.7–4.7 s; full UI
with page content ~4.9 s in the same conditions; the 0.1.753 first-search
freeze fix still holds (max 197 ms round trip across three cold cycles). The
remaining cost is not the app relay: it is Gecko's native chrome initialisation
and the app's first full layout. Getting below ~2 s needs engine-side chrome
startup work (skip native toolbar/utility init that Astra never shows) plus a
lighter first layout, which is tracked as the next startup task rather than
faked here.

## Owner report: first-navigation "Not Responding" — root cause and fix (2026-11-19)

The 10–11 s whole-window freeze after launching and loading the first real page
was **not** session restore, cache, the profile, Mica or the app frame. It was
the ad blocker's CNAME-uncloaking fallback running a **synchronous system DNS
query on the chrome main thread**.

| Evidence | Value |
|---|---|
| Installed 0.1.752, copy of the real profile, first Google search | chrome round-trip gap **11 132 ms** (boot itself max 35 ms) |
| Gecko profiler, chrome process, 1 ms samples | **300 of 385** stall samples at one native frame |
| Symbolized stack | `onLookupComplete` (`Blocker.sys.mjs:855`) → `Blocker.cname` (`303`) → `nsIAstraBlockerService.cname` → `AstraBlockerService.cpp:108` → `astra_blocker_engine/src/lib.rs:1344` → `DnsQuery_W` |
| `service.cname("accounts.google.com")` on the main thread | **11 085 ms** |
| Windows `Resolve-DnsName -Type CNAME` from PowerShell, same host | **11 082 ms** — the resolver's own timeout for a host that has no CNAME |

`resolveCloakedHost` already performs the correct async
`nsIDNSService.asyncResolve(..., RESOLVE_CANONICAL_NAME | RESOLVE_BYPASS_CACHE)`.
When the returned record did not carry a canonical name, it fell back to
`native.cname()`, which calls `DnsQuery_W(RR_CNAME)` synchronously. On this
network that call only ends when the resolver times out, and because it runs in
the `http-on-modify-request` DNS callback it blocks the UI thread — Windows
marks the window "Not Responding". It happened on the first page and not later
because the first host resolution pays the timeout; it affected Google,
YouTube and split views because they all resolve a first-party host.

**Fix:** the fallback is gone. Uncloaking reads the async record's
`canonicalName` and fails open (host stays uncloaked) when the platform does not
provide one. The native `cname()` seam stays only as a diagnostic and is
documented as main-thread-forbidden. `blocker_coverage` now fails if
`native.cname()` returns to the product path.

**Verification (installed 0.1.753, real profile copy, Windows 11):**
the exact reproducer that took 11 132 ms measures **156 ms**; four cold launch
→ first-search cycles plus shield off/on and a Google + YouTube split show
max 258 ms round trip and **zero gaps ≥ 400 ms**. Launch → first UI with the
owner's restored session: **5.4 s / 4.82 s / 4.92 s** across three cold
starts, worst chrome round trip 16 ms (the splash no longer waits on the
resolver). `blocker_coverage` 25/25
(including the new guard), `blocker_host` 97/97, `telemetry_blocklist` 40/40,
`state-check` and `brand-lint` clean. Artifacts:
`Astra-0.1.753-windows-x86_64.zip` (`68d8a184…`) and
`Astra-0.1.753-windows-x86_64-setup.exe` (`c18cd137…`).

**Not addressed here:** the Windows passkey provider choice, browser-wide UI
scale, the caption pill/top-bar rework, and the live probes still listed as
deferred below.

## Owner bug batch (2026-11-18, branch `fix/owner-batch-2026-11-18`)

Root causes fixed in the host and app, with contract/unit evidence:

| Area | Root cause → fix | Verification |
|---|---|---|
| Import browser data | `migrate()` received the profile **id**, but Chromium reads `aProfile.id`; it searched the user-data root and failed with "couldn't read". Pass the listed profile object and union every readable profile. | `migration_model` 31/31 |
| Firefox / Zen import | Only startup-only Firefox migrators exist; Zen has none. Added a host gecko-family reader over each installed profile's `places.sqlite` (bookmarks tree + history visits), offered next to Chrome-family sources. | contract mocks + `getRowsFromDBWithoutLocks` path; live Windows probe still required |
| Import back Astra exports | Added an "Astra export file" source using the existing `import_start` route: Netscape HTML through `BookmarkHTMLUtils`, `date,title,address` CSV through `PlacesUtils.history.insertMany`; private windows refuse. | round-trip cases in `migration_model` |
| Set as default | `default_browser_request` existed in the schema/binding but had **no host route**, so the UI got `unknown_command`. Routed to `System.defaultBrowserRequest`. | bridge test + `wire_coverage` 62/62 |
| Search default | UI default Google, host default DuckDuckGo. Host now defaults Google, matching Settings. | `search_model` 63/63 |
| New Tab background | `mediaUrl` rejected the tab projection's `"default"` profile (the store accepts it), so no `<img>` was ever created. Accept both ids. | `media.test` 21/21 |
| Window material | Opaque shell ground hid Mica; dotted Windows builds were parsed by the revision group. Shell now paints transparent over a material and reads `22631.4890` as build 22631. | `zoom_home_material` 48/48 |
| Hidden sidebar / peek | The full-stage frame mount still took pointer events outside the clipped card, and peek state survived a surface change, leaving a transparent window and a stuck card. Clip hit-testing to the frame, lower the card on every surface change, and make a hidden column hand the bar back to the stage. | `BarHover` 2/2, sidebar/app suites |
| Sidebar minimum | 180 px could not fit the one-row utility bar; the container query made it a 4×2 grid. Minimum is 252 px and the extended header is a size container. | `SidebarResizeHandle` 2/2, `sidebar-mode` unit |
| Page corners | Native `#tabbrowser-tabbox` painted square over the rounded app card. Added the native clip (8 px Windows / 12 px elsewhere). | static CSS; live screenshot deferred |
| Split duplicate panes | Adding an already-split tab duplicated it. Existing split membership/limit is checked; two different splits are refused instead of merged. | split unit 12/12 |
| Pinned tabs / spaces on quit | `Metadata.flush()` rewrote the stale snapshot, dropping the last debounce. It now saves current state first and falls back to the last accepted snapshot. | metadata host path; live restart probe deferred |
| New Tab / Home flash | `newTabShown` unmounted while Home reported `loading` for a blank target. A blank web tab keeps its surface mounted. | `BarHover` + app tests |
| Tools black flash | Opening a tool closed the current internal page first, remounting the whole stage twice. The panel now opens beside the page. | app unit suite |
| Copy / cut / paste | Clipboard commands went to the focused app frame, not the page. Copy uses the captured selection; cut/paste/select-all refocus the browser; commands are rebindable and skip Astra's own editable fields. | `keymap_model` 69/69; live clipboard probe deferred |
| Right-click with no engine model | The native popup was prevented but no Astra menu was drawn. A generic page menu is now drawn from the selected browser. | static path; live probe deferred |
| Ad blocker toggles | Global enable did not reload; the toggle cache could stay stale across its own reload. Both paths reload, re-read after settlement, and the gate is armed only after rules compile. | blocker unit/contract suites; live YouTube probe deferred |
| App shortcuts | Bindings were session-only and function keys were hardcoded. Overrides persist in `astra.keymap.overrides`, native keys are swept on change, and 4th/5th buttons stay DOM events. | `keymap_model` 69/69 |
| Window gradient shift | Raising the frame wiped the window ground even over internal pages. It is raised only when a live page is behind the popup. | `BarHover` + app tests |

**Still deferred (needs engine/build work, not faked here):** a Windows
built-in-vs-Windows-Hello passkey provider switch (the Astra vault is
Linux-only today), browser-wide UI scale with separate icon/text scales, the
window-caption pill → hover-only top bar, and live Marionette verification of
the gecko import, clipboard, ad-block and restart paths.

## Adblock Tester: 93 → 100 (2026-11-15)

The owner's export from <https://adblocktester.pages.dev/> scored 93 (410/443,
33 open). The 33 split into three causes, all closed:

| Cause | Fix | File |
|---|---|---|
| 29 subdomains (`log.tiktokv.com`, `sstats.adobe.com`, `net.rayjump.com`, `pixel.reddit.com`, `api.raygun.io`, `cookie-cdn.cookiepro.com`, …) that community lists match only for one request type, so a `fetch(no-cors)` reached them | reviewed inventory + generated `||host^$important` section (one rule per host, every type) | `blocker/lists/adblocktester-hosts.json`, `blocker/lists/astra-telemetry.txt` (`! >>> adblocktester-strict`), same generator: `blocker/tools/superadblock.py` (now writes both sections) |
| `/advertisement.js` and `/analytics.js` local baits | two `$script` heuristics beside `/ads.js`, `/pagead.js` | `blocker/lists/astra-telemetry.txt` |
| both cosmetic baits inserted after load were visible | five generic class/id rules **plus** the real bug: the page's `style-src` CSP dropped the actor's `<style>` node, so no cosmetic CSS ever applied. CSS now loads as an `AGENT_SHEET` through `windowUtils`; a batch carrying an unseen class/id is looked up immediately (32/document) and scans mutation records instead of the whole document | `overlay/astra/actors/AstraBlockerChild.sys.mjs` |

**Verification:** `adblocktester-probe.py --runs 3` → 443/443, score 100, zero
open rows on three consecutive runs of the packaged Windows build (200 862
compiled rules); `cargo test -p astra-blocker` 22/22 including the new
`benchmark_hosts` (every inventoried host blocked for six request types,
nested `myanalytics.js` untouched, cosmetic names resolve from a bare hint);
`blocker_coverage` 22/22; `blocker-probe` PASS (new assertion: the page sees no
style node); `superadblock-probe` still 482/482 headline 100. Docs:
`docs/astra/BLOCKER.md`. The probe is registered in `tools/perf/full-suite.sh`;
`superadblock-probe.py` now resolves the Windows build like the other probes.

## UI v2 lane (D-52, from 2026-11-15)

Layout only, taken from the owner's reference (New Tab, Search, Settings):
the column's head carries the page controls and the one address field, New
Tab reads name → day → field, Settings reads at a 680px measure. Palette,
fonts and every frozen search surface are unchanged. Branch `ui-v2`; not
merged — the owner reviews and confirms it first.

| Task | Branch | What | Verified |
|---|---|---|---|
| Column head | `ui-v2` | `PageNav` extracted from `ContentBar`; `Shell` composes the field once and renders it in the column's head or the bar; `SidebarHeader` three bands | svelte-check 0, eslint 0, stylelint 0, `NewTabLook`/`ShellA11y`/`BarHover`/`ShellLook`/`SidebarLook`/`SettingsInset`/`NarrowChrome`/`ThemeLook` component suites pass; golden screenshots of shell/newtab/settings in both themes |
| New Tab group | `ui-v2` | name, time and date, then the field; the page is no longer cut by a notch | `layout` unit 7/7, `NewTabLook` 4/4 |
| Settings measure | `ui-v2` | 680px column, 30px title, quiet group caption | golden screenshot (settings, dark) |

## Windows 11 x64 port (D-51, from 2026-11-14)

Plan: `docs/astra/WINDOWS_MASTER_PLAN.md`. Integration branch `windows-port`;
every task gets `win/<phase>-<slug>`, merges `--no-ff`, and is pushed to both
GitLab and GitHub. Locked owner decisions: full native build + all surfaces,
objdir/caches on `D:\astra-build`, Windows 11 x64, Windows Hello passkeys,
per-task branches, stock-first RAM budget, Linux paths unchanged, headed live
probes. Task rows are added here when each task starts.

| Task | Branch | What | Verified |
|---|---|---|---|
| W1 visual boot | `win/w1-headed-visual-probe` | OS-aware `headed-probe.py`: visible Windows launch, app-frame/relay/chrome assertions, Win32 `PrintWindow` capture | 10/10 PASS on the packaged Windows build (1600x1075 at 125% DPI) |
| W1 surface probes | `win/w1-surface-probes` | platform build selection for blocker/tabs/settings probes; tabs reads `gBrowser.selectedBrowser` | blocker 21/21, tabs PASS, settings-native 50/50 on Windows |
| W4 package/installer | `win/w4-portable-installer` | `package-windows.ps1` portable zip + NSIS per-user setup; `installer-test.ps1`; ships `astra.exe` as the product launcher | zip extracts and version-probes 8/8; installer 31/31 including live probe and clean uninstall |
| W3 system routes | `win/w3-system-windows` | real Windows default-browser, login-item, SmartScreen-policy and diagnostics routes; General/Privacy rows wired; contract imports are file URLs on Windows | system_model 120/120, wire 51/51, live system-probe 15/15; 63/64 contract suites pass on Windows |
| W1 window frame | `fix/windows-window-frame` | visible Windows caption controls, XUL window-drag edges, Astra boot mark and dark first paint; window-only capture helper | frame-probe 7/7, `WM_NCHITTEST` HTCAPTION at top gutter, controls 3→1→3, startup dark at 1.28 s / UI 2.99 s |

## Settings audit: Import/Export were dead on this engine (2026-11-15)

**Symptom:** Settings → General reported *No other browsers found on this
device* on a machine with Edge installed, and both export buttons failed.

**Root cause:** `Migration.sys.mjs` imported `IOUtils` from
`resource://gre/modules/IOUtils.sys.mjs`, which this engine no longer ships:
`IOUtils` is a chrome WebIDL global (see `dom/docs/ioutils_migration.md`). The
failed import made `modules()` return `null`, so import sources were always
empty and export always answered `failed`.

**Fix:** read `IOUtils` from the chrome global; offer only migrators with real
`getMigrateData()` for their profile (an empty browser is no longer listed, and
the test-only migrator is skipped); export bookmarks as Netscape HTML and
history as CSV, matching the copy in Settings.

| Surface | What works now | Files |
|---|---|---|
| Import browser data | Microsoft Edge is detected with its profile and readable kinds; an empty/test source is not listed | `overlay/astra/host/Migration.sys.mjs` |
| Export bookmarks | A Netscape bookmark file other browsers import | same |
| Export history | One CSV row per visit: `date,title,address` | same |

**Verification:** `node tests/contract/migration_model.mjs` 23/23 (including
the HTML/CSV shape and the empty/test-source cases); `tabs_settings` 50/50;
`zoom_home_material` 47/47; `wire_coverage` 62/62; live settings audit on the
rebuilt Windows dev build 94 controls / 0 failed. `Migration.importSources()`
returns `Microsoft Edge / Profile 1 / history` instead of `[]`; a live effect
pass covers 44 checks (accent, fonts, density, motion, contrast, material, page
bar, downloads ask, language, proxy, home, zoom, switch-to-open, close buttons,
New Tab wordmark/greeting/clock/trackers) and an 8-check theme pass covers
editing a colour and importing a shared theme. Those reported rows are not
defects.

## Owner release: alpha 0.1.745 distro packages (2026-11-11)

Owner override of the SCOPE packaging exclusion (P8+): alpha channel ships now
for all four supported families, built rootless with `nfpm` 2.48 from the one
staged 0.1.745 build (`tools/package-alpha.sh`, configs in
`tools/distro-packages/`). Same bits everywhere; only deps/hooks differ.

| Artifact | Family | Verified |
|---|---|---|
| `release/astra_0.1.745~alpha1_amd64.deb` | Debian/Ubuntu/Mint/Pop | control (Version, 12 Depends, Recommends), symlink + desktop + icons + AppArmor in data, extracted `firefox --version` 153.6.0esr via launcher and binary |
| `release/astra-0.1.745-0.1.alpha1-fedora.x86_64.rpm` | Fedora/RHEL/Rocky/Alma | header (13 Requires), postin/postun, byte-exact extract incl. symlink |
| `release/astra-0.1.745-0.1.alpha1-opensuse.x86_64.rpm` | openSUSE Leap/Tumbleweed | header (13 suse Requires), postin/postun, byte-exact extract incl. symlink |
| `release/astra-0.1.745.alpha1-1-x86_64.pkg.tar.zst` | Arch/CachyOS/Manjaro | `pacman -Qip` clean, new-format `.PKGINFO` (`pkgver` carries release), `.MTREE`+`.INSTALL` |
| `release/Astra-0.1.745-linux-x86_64.tar.xz` | portable fallback | pre-existing staged tarball, `sha256sum -c SHA256SUMS` 5/5 |

`release/` (556 MB) is committed for the manual release handoff; `release/README-alpha.md`
holds the install matrix. Not installed system-wide here (no sudo) — install
paths are layout-verified from extracted trees, not live-installed.

## Owner report: passkeys on Linux — Astra's platform authenticator (2026-11-11)

**Surface:** a person can create a passkey on a site and sign in with it, with
no security key. Firefox's Linux build has no platform authenticator, so every
resident-key/UV request ended at *"Touch your security key"*; Astra now serves
those requests from an encrypted vault in the profile and draws the prompt in
its own surface. The QR/caBLE hybrid path is documented but not shipped (the
only maintained Rust client says it is not cryptographically reviewed and the
flow needs a third-party tunnel relay plus BLE); `docs/astra/PASSKEYS.md` §7 is
the staged plan.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Create + sign in | a resident-key request creates an ES256 credential and returns `platform` / `internal`; an empty-allow-list sign-in resolves it | `engine/dom/webauthn/authrs_bridge/src/platform.rs`, `toolkit/components/astra_passkeys` (from `passkeys/engine`), `patches/ASTRA-0014` | probe: created, attachment `platform`, transports `internal`, signed-in id matches, signature present |
| Astra prompt | the native doorhanger is suppressed and Astra's sheet asks for the PIN; while it is open the shell raises the app frame over the page (a sheet is a pop-up like a menu), so it is visible with the bar hidden too | `toolkit/modules/WebAuthnPromptHelper.sys.mjs`, `overlay/astra/host/Passkeys.sys.mjs`, `ui/app/src/features/passkeys/**` | probe: sheet rendered, PIN field + Continue, prompt type `pin-required`, frame raised over the page and lowered again after the answer |
| Settings | browser-wide on/off, create the vault, set/change the PIN, system authentication, unlock/lock, list and remove; the card keeps its action row inside the rounded surface and the vault KDF is ~100 ms (was 1.8 s through NSS's per-call HMAC) | `ui/app/src/features/settings/components/PasskeysGroup.svelte`, `domain/passkeys/**`, `passkey_call` route | probe: switch off → UVPAA false; wrong PIN refused, retries drop, right PIN unlocks; one credential listed |
| At rest | AES-256-CBC + HMAC-SHA256 (encrypt-then-MAC, NSS), vault key wrapped with PBKDF2-HMAC-SHA256-600k over the CTAP2 PIN hash; 0600 file, 0700 dir | `passkeys/engine/src/{seal,vault,pin,pbkdf2}.rs` | probe: file 0600, no PIN and no RP id in clear, sealed `ct`/`tag` present; 16 crate tests |
| Private windows | a prompt in a private context is cancelled before the token can create or use a credential | `Passkeys.sys.mjs` (`isPrivateContext`) | contract: private prompt cancelled + not shown (live private-window probe deferred) |

**Verification:** `passkeys/engine` `cargo test` 16/16; `tests/contract/passkeys_model.mjs`
19/19; `wire_coverage.mjs` 51/51; `crates/astra-proto/check-drift.sh` clean;
`hostapi_v1` 341, `settings_native` 105, `native_surfaces` 125/125;
`bun run typecheck` 0/0 and the passkey model unit tests 3/3; `forge lint`
14/14; `state-check` and `brand-lint` clean; `build:chrome` staged 783 files
with a clean CSP audit; engine `build --jobs 2` succeeded;
`tools/marionette-probe/passkeys-probe.py` **26/26** on the packaged dev build.
The engine build needed the documented low-memory recipe (thin LTO on the final
`gkrust` invocation) because fat LTO peaked at 18.3 GB and was OOM-killed while
the editor held the desktop; zswap is already enabled on this machine.

**Deferred / limits:** conditional mediation (passkey autofill in a username
field) needs a provider constant in `nsIWebAuthnService.idl`; PRF/hmac-secret
is not advertised; a non-discoverable assertion is routed to USB unless the
allow-list transports include `internal`; the Settings PBKDF2 runs on the main
thread (~100 ms on unlock); the private-window refusal is
contract-tested, not driven through a real private window; the built chrome
assets and `overlay/astra/jar.mn` are regenerated by `build:chrome`.

## Owner report: sidebar utility bar — one extension door, resize-safe layout (2026-11-11)

The head of the column had two puzzle buttons (a manage/store menu and the
extension hub) and wrapped into a ragged second row at the default 240px,
leaving the theme plate alone beside the shield. Both are fixed.

| Surface | What changed | Files | Verified |
|---|---|---|---|
| Extension door | one puzzle button; the hub now carries installed extensions, page actions, Manage, Chrome Web Store, Firefox Add-ons and Install from file | `features/rail/components/UtilityBar.svelte`, `features/extensions/components/ExtensionHub.svelte` | UtilityBar + ExtensionHub component suites; live Playwright `shell.spec.ts` "one extension door…" |
| Utility bar layout | one row with room; a centred 4×2 grid when the column is ≤260px, 24px plates ≤196px, the rule hides in the grid, and the shield aligns to the first row | `UtilityBar.svelte`, `features/sidebar/components/SidebarHeader.svelte` | UtilityBar tests at 320/240/180; live drag tests in `shell.spec.ts` |
| Popovers in dark mode | every menu/disclosure opened from the column is opaque (`data-menu-material="opaque"`), and the address tray is solid, so the tab list never reads through a panel's labels | `features/sidebar/components/Sidebar.svelte`, `UtilityTray.svelte` | MenuMaterial suite; live Playwright asserts the hub panel is opaque |
| Store bug | the hub's "Chrome Web Store" row opened the Firefox store; each store now opens its own URL | `ExtensionHub.svelte` | ExtensionHub component suite |

**Verification:** `bun run --filter @astra/frame check` green (typecheck 0,
eslint/stylelint/prettier/knip clean, 1249 unit tests); the four touched
component suites 37/37; live Playwright `shell.spec.ts` 3/3 for the resize and
opaque-hub checks; live `utility-bar-probe.py` 30/30 against the rebuilt
packaged dev build (four-column grid, one extension door, opaque hub, media
popover inside the column, tool-panel head, hide/peek). The full
`shell.spec.ts` still fails four checks that depend on elements absent from the
frozen golden shell (the "Address and search" textbox and the Browse/Work
radiogroup); those files were not touched here and the failures are reported
separately. `bun run --filter @astra/frame build` also still fails at the
startup-request budget (40 vs 24); `build:chrome` is green and this change adds
no startup graph node, so the failure is reported separately.

## Review follow-ups: shield pause, procedural ads, timer target (2026-11-10)

A review of the blocker/FPP batch found five issues; all are fixed on
`fix/blocker-review-followups`:

| Finding | Fix | File |
|---|---|---|
| Per-site **Aggressive** used `+AllTargets`, which re-adds `ReduceTimerPrecision` and brings the 16.667 ms timer clamp back on that site | `+AllTargets,-ReduceTimerPrecision`; the contract rejects a bare `+AllTargets` | `overlay/astra/host/Privacy.sys.mjs` |
| The query skip also skipped **procedural** actions (`:has-text`, `:style`, `:remove`) for later nodes | the last procedural set is cached and re-run on each debounced batch, without a parent round-trip | `AstraBlockerChild.sys.mjs` |
| `#seenClasses`/`#seenIds` grew without bound and sent more names than the parent accepts | both are bounded to the parent's 512-name window; the initial walk is reused instead of walking twice | `AstraBlockerChild.sys.mjs` |
| Pausing shields stopped Astra's engine but not native ETP, so Disconnect-listed hosts stayed blocked while the shield read "off" | pause writes `trackingprotection` / `trackingprotection-pb` permissions on the site principal, and removes them on resume; applied at startup too | `overlay/astra/host/Blocker.sys.mjs` |
| Docs still listed `ReduceTimerPrecision` and said native ETP was not set | both corrected | `FINGERPRINTING.md`, `PRIVACY_PREFS.md` |

**Verification:** `blocker_coverage` 16/16; blocker-probe PASS; sidebar-shield
10/10; superadblock 482/482, headline 100; Speedometer 3.1 20.0 ±0.95 (10
iterations). The ETP permission path is contract-checked and follows
Firefox's own permission model; it is not live-probed against a real
Disconnect host in this pass.

## Owner report: Speedometer 3.0/3.1 — why it was low and what changed (2026-11-10)

The benchmark was failing outright, not just scoring low. FPP's
`ReduceTimerPrecision` target clamps `performance.now()` to **16.667 ms** (one
60 Hz atom); Speedometer 3.1 then aborts with `Got invalid 0-time total for
suite TodoMVC-Vue: 0`. The runtime writer in `Privacy.sys.mjs` was also
overwriting the shipped override set at startup with the old list, so the new
FPP targets never applied. Both are fixed: the target is gone, both writers
agree, and `performance.now()` is back to the engine's 1 ms floor.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Speedometer 3.1 | 19.9 / 20.2 / 20.2 (10 iterations, 3 runs), mean **20.1** | `tools/perf/speedometer/run_speedometer.py` (local 3.1 tree, real display, Hyprland geometry) | `out/speedometer/baseline-3.1-3.1.json` |
| Speedometer 3.0 | 19.8 / 20.5 (5 iterations, 2 runs) | same harness, hosted 3.0 page | `out/speedometer/baseline-3.0-3.0.json` |
| Timer precision | 16.667 ms → **1 ms**; the 0-time suite error is gone | `overlay/astra/mozilla.cfg`, `overlay/astra/host/Privacy.sys.mjs` | live `performance.now()` sample: min 1 ms, 258 distinct values |
| Cosmetic actor cost | the parent query is skipped when the class/id set is unchanged, the debounce is 500 ms, same-origin iframes are no longer walked twice, and the actor does not start when the blocker is off | `overlay/astra/actors/AstraBlockerChild.sys.mjs`, `AstraBlockerParent.sys.mjs` | Speedometer 20.1 after the change; blocker-probe still PASS |
| Protection cost | blocker off 19.4, FPP off 19.5, everything off 19.6 — no measurable Speedometer cost | harness `--pref` A/B | `out/speedometer/*.json` |

**Why 20 and not 140.** Speedometer 3 is not a percentage and has no
"infinity" result; it is calibrated against a reference machine and a fast
desktop browser scores in the tens. The remaining gap to the 28.0 reference
(Firefox 159, same machine) is the build: this dev binary has **no PGO and no
LTO** (`MOZ_PGO: ''`, no `MOZ_LTO`), while the reference is a PGO+LTO build six
engine versions newer. PGO is the next lever (~10-20%); it is a two-stage
build and was not run here because the full build is ~70 min and this box has
already OOM-killed an uncapped build. Recipe and numbers: `PERF.md` §7.

**Verification:** `tools/perf/speedometer/run_speedometer.py` 3.1 3/3 and 3.0
2/2 PASS; `blocker_coverage` 13/13; blocker-probe PASS; `superadblock-probe`
still 482/482. The harness is manual (real display, ~35 s per 3.1 run) and is
not in `full-suite.sh`.

## Owner report: 100% ad/tracker coverage + hardened fingerprinting (2026-11-10)

The public Super Adblock Test probes 482 ad, tracker, analytics, social,
consent, affiliate, video-ad, OEM and malvertising hosts with
`fetch(no-cors)`. Community rules often match those hosts only for one
resource type, so a fetch beacon could reach them even while the script was
blocked. The bundled Astra list now carries a host-anchored,
type-agnostic `$important` rule for every probed host, and the browser-wide
privacy posture is strengthened.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Super Adblock Test | headline 100 and raw 482/482 blocked, 0 reachable, on three consecutive runs after the live 14-list refresh | `blocker/lists/superadblock-hosts.json` (reviewed inventory), `blocker/tools/superadblock.py` (generator + `--check`), `blocker/lists/astra-telemetry.txt` (`! >>> superadblock-strict`), `tests/contract/blocker_coverage.mjs` | `tools/marionette-probe/superadblock-probe.py` PASS, 3/3 runs; `out/superadblock/report.json` |
| Request-type coverage | every strict rule is `||host^$important`, so `fetch`/XHR, script, image, subdocument and beacon requests all match; `vk.com` stays path-scoped to `/rtrg` | same generator, `SKIP` guard | contract: 461 scored + 476 probed hosts covered |
| Fingerprinting | FPP gains WebGL capability/pixel randomization, WebGPU limits, WebCodecs, device labels, frame rate, media errors and video playback statistics | `overlay/astra/mozilla.cfg` (`privacy.fingerprintingProtection.overrides`) | `fingerprint-probe.py` PASS; `blocker_coverage` asserts every target |
| Tracker layers | native ETP Disconnect list, cryptominer and fingerprinting lists, email tracking-pixel stripping, query stripping and referrer trimming | same file | `shields-probe.py` PASS; contract asserts every pref |
| Breakage recovery | social SDKs, consent banners, chat/push/email widgets and affiliate redirectors are blocked; the per-site shield pauses blocking for one site | existing `SiteShield` / address shield (`blockerSites.setProtected`) | `sidebar-shield-probe.py` still PASS |

**Verification:** `node tests/contract/blocker_coverage.mjs` 11/11,
`telemetry_blocklist` 40/40, `privacy_host` PASS; live `blocker-probe.py`,
`fingerprint-probe.py` and `shields-probe.py` PASS; the new probe and contract
are registered in `tools/perf/full-suite.sh`; `superadblock.py --check` is
clean and the packaged gzip matches the list text.

**Trade-off:** blocking `connect.facebook.net`, consent platforms and chat
SDKs removes the corresponding widget on sites that use them. The per-site
shield is the documented recovery path; leaving them reachable is the partial
protection the owner rejected.

## Consolidation: every pending branch is on main (2026-11-10)

The whole open set moved onto `main` in four merges, in this order:

| # | Merged | Commits | What it carried |
|---|---|---|---|
| 1 | `fix/media-popup-now-playing` | 61 | the 25-item owner batch, the sidebar shield, and the 29 per-issue branches merged under it |
| 2 | `integration/menus` | 3 | the back/forward, sidebar-options and tool-shelf menus drawn in the app (`TabHistory`) |
| 3 | `fix/tab-drag-ghost-stuck` | 1 | a tab drag the row never saw released |
| 4 | `feat/topbar-customization` | 1 | top bar utilities: extension hub, appearance switch, sleeping marks |

Conflicts were three, all additive: two in this file (owner-report sections,
kept newest first) and two in `System.sys.mjs` (`logsDirectory`/`redactPath`
and `diagnosticsReport`, absent from `main`). Nothing was dropped: the merged
tree matches the batch branch, and `main`'s own four commits were already
carried by the duplicated 0.1.742 lineage the branch grew from.

**One stale test was corrected, not silenced.** `ui/shell/src/host-model.test.mjs`
still asserted the pre-batch history contract (the first page replaces the New
Tab). The batch reversed that on purpose and `tests/contract/hostapi_v1.mjs`
already proves it, so the shell test now asserts the same contract while
keeping its own point: two loads of one address add a single entry.

**Verification:** `bun run --filter @astra/frame check` green (typecheck 0,
eslint/stylelint/prettier clean, knip clean, 1249 unit tests); the 34 contract
suites in `tools/perf/full-suite.sh` PASS; `node --test ui/shell/src` 74/74;
`forge lint` 13/13; `state-check` and `brand-lint` clean; `build:chrome` green
(781 files staged, CSP audit clean), so the startup-asset budget the top-bar
lane reported is no longer exceeded. The ten component suites the merges
touched pass (63/63) in Chromium; the full component project was not driven to
the end — it runs every file sequentially in a real browser, and files this
merge never touched (e.g. `SpacesLook`, `OnboardingApp`, `PageRequestCard`)
time out at ~15 s under load.

## Hardening run: window identity, private isolation, downloads, tab order (2026-11-10)

Work branches (each merged with `--no-ff` into
`integration/hardening-20261110`, then `main`):
`fix/window-identity`, `fix/private-metadata`, `fix/private-bookmarks`,
`fix/page-source-window`, `fix/private-split-storage`, `fix/media-window-scope`,
`fix/private-durable-writes`, `fix/metadata-secondary-window`,
`fix/downloads-lifecycle`, `fix/tab-order-and-history`,
`fix/favicon-double-fetch`, `fix/favicon-cache-bound`,
`fix/search-contract-default`, `fix/edge-matrix-native`, and the probe-timing
fixes `fix/webrtc-dismiss-probe`, `fix/webext-action-probe`,
`fix/native-surfaces-divider-probe`.

| Surface | What changed | Verified |
|---|---|---|
| Window identity | `__bindCurrentWindow` allocates `win-N` per native window; the model keeps a per-window selection, window-relative indexes, and one window-scoped `items-changed` snapshot per window. Content reads its own selection. | contract `window_scope` 17/17; live `multi-window-isolation-probe.py` 11/11 |
| Private windows | private prepare/init/flush/dispose never touch the organisation store; the chrome bookmark shortcut, Notes, media import, Migration start/export are refused; the Source driver is per window; split layout uses in-memory storage; Media engine/view is per window. | `metadata_restore` 74/74, `page_source_model` 20/20, `media_model` 63/63, shell unit 76/76; live isolation probe |
| Second normal window | Metadata refuses a non-owner's dispose/release and does not reload the snapshot over the owner's. | `metadata_restore` secondary-window checks |
| Downloads | pause = cancel, resume = start (with one retry for the canceled attempt), keep = unblock, discard = confirmBlock/remove. | `downloads_model` 126/126; live `downloads-lifecycle-probe.py` 15/15 (pause, paused, resume, full-size file, cancel, discard) |
| Tabs | a moved row now reorders `gBrowser`; a restored tab seeds the model from SessionStore history; native close restores the closing tab without polluting MRU. | `window_scope` 17/17; live `tab-order-probe.py` 6/6; `sessionstore_probe.py` PASS with `canGoBack` |
| Favicons | one read per origin (coalesced and cached, including "no icon", bounded at 256 origins), so an iconless page is not downloaded twice per commit. | `favicons_model` 39/39; edge matrix doc-request counts |
| Edge matrix | reads the native stage, waits for the bar inset, counts document requests, treats Work as off (D-48), closes a second window rather than the last. | live 21/21 |

**Limits still open:** multi-window spaces/pins are merged into one store
(P5b-3); a second normal window still shares the active space; private
windows can still open browser pages (their durable writes are refused); the
`AsyncTabSwitcher` assertion seen while closing a private window under the
hidden Weston compositor is engine-side and did not reproduce outside it.

**Installed verification (0.1.744).** The tarball was installed over the
previous `~/.local/opt/astra` with the bundled `install.sh`. `version-probe.py`
reports `astra.version` 0.1.744 and About `Version 0.1.744`; the installed
binary passes the edge matrix (21), multi-window isolation (11), downloads
lifecycle (15), tab order (6), tabs churn (20) and native surfaces (44/44).
A copy of the existing `~/.mozilla/astra` profile boots on the installed build
with `Metadata.status().available === true`, `restored === true`, three spaces
and its tab. The old process was still running while the folder was replaced,
so a restart is required to pick up the new binary.

**Perf (0.1.744, installed binary, `run_all.py --runs 1`):** startup 0.302 s
cold / 0.301 s warm; 1-tab baseline 674 MiB, 10 tabs 929 MiB, 50 tabs 947 MiB,
50 sleeping 1 177 MiB; tab switch 21.5 ms median (p95 87.5); scroll step
16.7 ms median; blocker 131 724 rules, p95 2 616 ns. The memory numbers are
higher than the 2026-11-02 table because that table predates the native tab
stage and the current UI; the stock-ESR column is still TODO, so no budget
verdict is claimed. `perf-0.1.744` holds the JSON.

## Dev/alpha version 0.1.742 (2026-11-10)

The first build handed to dev/alpha testers carries Astra's **own** product
version `0.1.742`. It lives in `branding/astra.toml` (`version`), separate from
the Firefox pin in `upstream.toml`; bump that one value on every build that
leaves the machine.

| Path | What it does |
|---|---|
| `branding/astra.toml` | single source; `forge overlay` fails without it |
| `overlay/astra/branding/pref/astra-branding.js.in` | renders `pref("astra.version", …)` |
| `overlay/astra/host/System.sys.mjs` | `about_info` answers `{version, os, arch}` from real process reads; any fact missing is `null` |
| `tools/package-release.sh` | archive name `Astra-0.1.742-linux-x86_64.tar.xz` + `BUILD.txt` (engine pin recorded separately) |

Verified: `system_model` 99/99, `diagnostics_model` 12/12, and
`tools/marionette-probe/version-probe.py` against the packaged tarball — About
renders `Version 0.1.742` (`Linux … · x86_64`), `astra.version` = `0.1.742`,
engine still reports Firefox `153.6.0`. The tarball is
`out/release/Astra-0.1.742-linux-x86_64.tar.xz`.

## Owner report: per-site blocking toggle in the sidebar (2026-11-10, latest)

The sidebar now carries a shield for the page in front, so the whole ad/tracker
blocker can be switched off and on for one site without opening Settings or the
address panel.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Sidebar toggle | shows the page's host, reads on/off, and flips the site policy; an off site is marked with the warning colour and a ban glyph | `ui/app/src/features/sidebar/components/SiteShield.svelte`, rendered by `SidebarHeader.svelte` (expanded trailing edge, compact head) | `sidebar-shield-probe.py` 10/10: exists, names `127.0.0.1`, starts on, click pauses, page reloads, click resumes |
| Same policy as the address shield | `blockerSites.setProtected`; a global off turns blocking on instead | `$domain/blocker` (`setProtected`), `blocker.setEnabled` | probe: `paused:false → true → false`, page requested twice |
| Fresh status | status is re-read on every commit (site context revision) and retried briefly while lists install | `SiteShield.svelte` effects | probe: a pause after the reload is accepted, not refused as stale |

**Verification:** `SiteShield.component.test.ts` 3/3 (on, paused, global-off);
`svelte-check` 0/0; scoped eslint/stylelint clean; live
`tools/marionette-probe/sidebar-shield-probe.py` 10/10 on the packaged dev
build; added to `tools/perf/full-suite.sh`. The full UI gate was not run to
completion because another lane has an in-progress webextension change in this
worktree (`ExtensionRow.svelte` boundary lint), which is outside this surface.

## Owner report: the 25-item list (2026-11-10, latest)

One branch per issue, merged into `fix/media-popup-now-playing`; the packaged
dev build (engine `build --jobs 2`, then `overlay` + `build --faster`) was
probed live with `tools/marionette-probe/owner-report-probe.py` (**24/24**) and
`tools/perf/stress/sessionstore_probe.py` (restore: both pages, model and
native). Contract suites are green (see "Verification").

| # | Surface | What changed | Verified |
|---|---|---|---|
| 1 | Continue where left off | `Content.ensureTab` no longer reuses a pending SessionStore tab as the bootstrap blank; adoption reads `SessionStore.getLazyTabValue`; the bootstrap cleanup decides by the native URL | live `sessionstore_probe`: 2/2 pages after quit/relaunch |
| 2 | Home URL | Home control in `ContentBar`; bare hosts normalise to https; words/other schemes rejected | unit `home-url` 3/3, typecheck |
| 3 | Import / Export | new `Migration.sys.mjs` over `MigrationUtils` + Places export, native save picker, progress snapshots, import-progress channel; 5 routes | contract `migration_model` 15/15 |
| 4 | Download folder | `nsIFilePicker.init` takes a BrowsingContext; fixed Downloads, MediaImport, WebExtensions | contract `native_file_picker` 6/6 |
| 5 | Back leaves page unclickable | top-level `STATE_STOP` clears loading + history direction; busy-false clears it; loading slot is pointer-transparent | live: page loads, Back works, stage not loading |
| 6 | tlauncher dark | a filter-list document verdict no longer cancels the navigation (subresources still blocked); source of truth in `blocker/engine/AstraBlocker.cpp` | live: tlauncher URL committed; document rule still matches |
| 7 | Accent colour | Appearance has the missing accent picker writing `ui.accent`; catalog row | typecheck/format/unit |
| 8 | Reset all zoom | `Zoom.forget*` resets live browsers through the window's `FullZoom` | live: page returns to 100%; `zoom_home_material` 46 |
| 9 | Back to the first New Tab | about:blank is the tab's first history entry; first page pushes above it; Content can load about:blank | live: B→A→New Tab |
| 10 | Links from other apps | the native tab is adopted and committed by the normal path | live handoff: `firefox -url` adds the URL to the model |
| 11 | Switch to existing tab | `tabs.switch-to-open` reads in `Tabs.create`; Duplicate bypasses it | live ordinary open reuses, Duplicate copies |
| 12 | After close | native removal re-asserts the closing tab, suppresses engine TabSelect, applies the model's choice to deck | live: previous tab selected in model + native |
| 13 | Close button always | compact `TabRail` reads `tabs.close-button` and exposes `data-close-buttons` | component `SpaceRail` 6/6 |
| 14 | New Tab background picker | MediaImport accepts the app's `default` profile token; picker context fixed | contract 42/42 |
| 15 | Unblocked tracker hosts | 39 host-anchored `$important` rules in the bundled Astra list; seed refreshed | live `checkUrl`: 39/39 block; `telemetry_blocklist` 40 |
| 16 | Focus shut sites | host raises `focus.cover=<site>` on navigation; shell returns the tab to its New Tab | live: shut site leaves the stage; `time_model` 189 |
| 17 | Inactive tab sleeping | untouched `browser.tabs.unloadOnLowMemory` reads as Astra's on default; driver starts on Linux; retry extended | live: setting true + driver running |
| 18 | Copy bookmarks between spaces | a missing source folder is an empty import, not `missing` | contract `spaces_profiles_model` 39 |
| 19 | Shortcuts | 15 s Save/Cancel pending capture; Mouse3/4/5 in both parsers + shell; platform passed; shell reloads keymap on `keymap-changed` | component `KeyboardPage` 2/2; `keymap_model` 69 |
| 20 | Native error pages | `about:neterror`/`about:blocked` map to Astra's failed pane; document loads are not cancelled | contract `dialog_prompts_cert` 31; live tlauncher |
| 21 | Clear-data time range | portalled menu layer raised above the dialog scrim/panel | static `menu_layer` 5/5 |
| 22 | Diagnostics | real redacted report from this process/profile | live: report text returned |
| 23 | Show logs folder | reveals `ProfD/astra/logs` (or `ProfD`) | live: reveals; contract `diagnostics_model` 11 |
| 24 | Loading skeleton | moved out of the inset page card: full content column, no rounded card | shell build + typecheck |
| 25 | Incognito | `window.new/newPrivate/togglePrivate/closePrivate` admitted by host and shell; private window opens | live: command admitted, private window appears |

**Verification:** `bun run --filter @astra/frame check` (0 errors; 1249 tests,
2 environment skips); contract suites listed above; `forge lint` 13/13;
`state-check` and `brand-lint` clean; live `owner-report-probe.py` 24/24 and
`sessionstore_probe.py` PASS.

**Deferred / limits:** Focus removes a shut site from the stage but the
request-level cancel still needs the engine Net hook (`FocusBlockHook` is not
registered); import/export pickers and the clear-data range were verified by
contract/static layering, not driven through a native dialog; the skeleton is
verified by build and CSS contract, not a screenshot assertion.

## Owner report: the older space's floating player stays live (2026-11-10, latest)

**Symptom:** after adding a space while a video played in the older space, that
space's floating PiP player kept the last frame, title and transport state. Its
clock and play/pause stopped following the site (reported on YouTube).

**Root cause:** adding the space hides the old tab, and automatic PiP opens
afterwards. The clone could attach while the source was still parked, so it
stopped receiving frames and state. The engine also sets the
`pictureinpicture` tab marker directly, which only refreshed the sidebar
projection; it did not wake a parked source. The head strip read the player's
own browser title ("Picture-in-Picture"), never the cloned tab's title.

**Fix:** the per-tab marker observer in `Content.sys.mjs` now activates the
source when the marker appears, and lets the tab in front decide again when the
player closes. `PipPlayer.sys.mjs` resolves the cloned tab through
`PictureInPicture.weakWinToBrowser`, reads its title, follows the tab's label
while the player is open, and retries as the engine links the window and
source.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Older-space player | the auto-opened player keeps advancing and following the hidden site | `overlay/astra/host/Content.sys.mjs` (`pipObserver` activation), `overlay/astra/pip/PipPlayer.sys.mjs` (`sourceBrowser`, `syncTitle`) | `pip-space-state-probe.py`: clock 0:04→0:07, title Track 2→Track 3, pause/play both followed |
| Parked source | a player requested for an already-hidden source wakes it before the clone is set up | `Content.sys.mjs` (`pipObserver`, `attachMedia`) | same probe: source parked, card PiP admitted, marker set, `docShellIsActive` true |
| Title strip | the head names the cloned tab and follows its label | `PipPlayer.sys.mjs` (`TabAttrModified`, retries) | same probe: head Track 2→Track 3; falls back to empty when the source has no title |

**Verification:** `pip-space-state-probe.py` PASS on the packaged dev build
(added to `tools/perf/full-suite.sh`); a real YouTube watch page in the same
build after adding a space: head titled "Rick Astley - Never Gonna Give You Up
(Official Video) (4K Remaster) - YouTube", timestamp 0:04→0:07, player
playing; `pip-minimize-probe.py` and `now-playing-probe.py` still PASS;
`forge lint` 13/13; `state-check` and `brand-lint` clean.

## Owner report: a parked page left the real page hidden (2026-11-10)

**Symptom:** opening Settings and then choosing a web tab left the page area
dark. Every page opened after that stayed dark too, until Settings was closed
through its own Back control. The window still showed the sidebar and the tabs.

**Root cause:** the native page surface is a sibling layer under the app frame.
The shell takes that layer out of front while one of the app's own pages owns
the window, and it did so from `data-internal` on the content slot: set by any
`ui-command browser.*` and cleared only by `browser.return`. Browser pages are
tabs now (2026-11-09): choosing a web tab **parks** the page in the app
(`surface.park()`), which never reaches the host, so no command cleared the
flag. The content slot stayed `display:none`, the stage stayed `app`, and every
later page was painted behind the hidden slot.

**Fix:** the app is the authority on which surface is in front. It posts
`{ ns: "astra-shell", kind: "surface", internal }` whenever the page in front
changes — a page open, a page parked, a web tab in front — and the shell adopts
or clears `data-internal` from that message. The `ui-command` mapping stays as
the first word before the app frame has booted.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Return from a page | choosing a web tab parks Settings and the real page comes back in front | `ui/app/src/app/browser/Shell.svelte` (`surfacePosted` effect), `ui/shell/src/Shell.svelte` (`kind === "surface"` handler) | `surface-park-probe.py`: stage `page`, `data-internal` cleared, content `display:flex` (before: `app` / `true` / `none`) |
| Later pages | a page opened after the round trip paints normally | same files | same probe: second tab loads and the stage stays `page` |
| App page in front | Settings still covers the window; the native page stays alive but unpainted | same files (`data-internal` set from `internal: true`) | same probe: stage `app`, content `display:none` while Settings is in front |

**Verification:** `bun run typecheck` 0/0; `eslint` clean; `prettier --check`
clean; 1246 unit tests pass (2 environment skips); `Shell.component.test`
3/3 (asserts the posted `internal` values); `node --test ui/shell/src` 74/74;
`shell_assembly.mjs` PASS; `wire_coverage.mjs` 50/50; `content_slot.mjs` 33/33;
`state-check` and `brand-lint` clean; new live
`tools/marionette-probe/surface-park-probe.py` PASS on the packaged dev build
(added to `tools/perf/full-suite.sh`).

## Owner report: Back/Forward go all the way to either end (2026-11-09)

**What changed:** Back and Forward stepped the model and then loaded the
target URL again in the page. That made a new native history entry for every
step, so the browser's own stack and the bar's stack diverged; a redirect or a
duplicate native entry could truncate the pages ahead and the bar could not
walk the whole history. The buttons now drive the engine's own session history
(`browser.goBack(false)` / `goForward(false)`), which keeps bfcache, POST
results, scroll position and form state.

The model still steps once so the buttons update immediately. Commits produced
by the traversal fold the address the engine really landed on back into that
same entry (or follow a skipped native entry), so a redirect no longer creates
a new entry or drops the Forward branch.

| Surface | Wiring / files | Live evidence |
|---|---|---|
| Back / Forward | `overlay/astra/host/Navigation.sys.mjs` (`history: "back"`/`"forward"` on the commit), `overlay/astra/host/Content.sys.mjs` (native history move + commit-direction wrapper) | 4-page probe: Back reaches the first page (button disabled), Forward reaches the last (button disabled) |
| Native stack stays aligned | same files (`__commitExternal` history branch) | `bar-nav-probe.py` native history after Back + Forward: index 2, count 3 (was index 4, count 5); external-link and meta-refresh redirect probes add no entries |
| Redirect / skipped entry | `__commitExternal` folds the landed URL into the current entry or follows it in the direction of travel | `hostapi_v1` checks: forward branch survives, redirect rewrites its entry, skipped back leaves Forward available |

**Verification:** `hostapi_v1` 336/336, `native_surfaces` 125/125,
`content_slot` 33/33, `slots_model` 39/39; live `bar-nav-probe.py`,
multi-step Back/Forward probe and external/redirect probe on the packaged dev
build. `state-check` and `brand-lint` clean.

## Owner report: split panes keep their layout and every boundary resizes (2026-11-09)

**What changed:** Three-pane split views were laid out in the wrong visual
order. The engine's split CSS only gives columns 0 and 1 an `order`, so a third
pane (column 2) fell back to `order: 0` and rendered before column 1. Astra's
per-boundary handles use tab order, so the handle between panes 1 and 2 resized
the tab that was visually third instead. The shell now pins columns 1 and 2 to
their tab order.

Pane widths were also stored only as pixel `width` attributes. Switching to a
non-split tab and back, or hiding/showing the sidebar, left those pixels stale
(or zeroed while the deck had no geometry), which is the broken layout in the
report. The host now keeps each split view's pane shares and re-applies them to
the current stage width whenever the panel deck resizes, and repositions every
resizer through the 400 ms sidebar slide rather than once at the start.

| Surface | Wiring / files | Live evidence |
|---|---|---|
| Pane order | `overlay/astra/chrome/shell-chrome.css` (`[column="1"]`/`[column="2"]` order) | 3-pane probe: panels left-to-right are columns 0,1,2 |
| Resize every boundary | `overlay/astra/host/SplitView.sys.mjs` (`resizePair`, resizer reconciliation, `scheduleResizerPosition`) | two handles, both hit-test as `.astra-pane-resizer`; first pair changes while the third pane stays put |
| Stable layout | same file (`_paneRatios`, `paneWidths`, `applyPaneWidths`, tabpanels `ResizeObserver`) | switching away/back keeps widths 346/140/177 (no 0-px pane); sidebar hide reflows to 473/189/241; resizers stay on both boundaries |
| Missing geometry | `paneWidths` refuses a 0-width stage instead of writing 0-px panes | contract test |

**Verification:** `node tests/contract/native_surfaces.mjs` 125/125;
`tools/marionette-probe/native-surfaces-probe.py` 44/44 on the packaged dev
build; targeted three-pane live probe measured every state above. `state-check`
and `brand-lint` clean.

**Limit:** the 140 px pane floor is the engine's own split minimum; an
arrangement still stores one divider share, so restoring three panes splits the
remainder evenly.

## Owner report: floating bar hit box + Back/Forward (2026-11-09)

**What changed:** The floating bar stays down for as long as the pointer is
anywhere on it. The shell's top-edge strip and the app's bar sit in two
documents, so crossing from one to the other reports leave/enter in an order
neither side controls; the strip's leave used to schedule the hide even after
the pointer had reached the bar, so the bar retracted on its own and Back /
Forward could not be clicked reliably. The trail timer now decides on the
pointer's current homes (strip or bar), not on which handler ran last. The
strip also starts at the bar's left edge instead of 8px inside it, so the whole
bar width reveals. Back and Forward were already wired; they now stay
reachable and were re-verified with a real pointer and external page history.

| Surface | Wiring / files | Live evidence |
|---|---|---|
| Bar stays under the pointer | `ui/app/src/app/browser/Shell.svelte` (`barRevealHover`, `barPointerInside`, `barEnter`/`barLeave`, `revealEnter`/`revealLeave`, source-aware `releaseBar`) | `bar-probe.py` PASS including the new strip→bar crossing case; real-pointer `/tmp/opencode/bar-hover-probe.py`: hover → bar shown, move onto address/back → still shown, leave page → hidden |
| Reveal spans the bar | `ui/shell/src/Shell.svelte` (`.astra-bar-reveal` inline start = sidebar + 8px, matching the app's shell gutter) | `bar-probe.py`: reveal strip and bar left edges now align |
| Back/Forward | `ui/app/src/features/toolbar/components/ContentBar.svelte` (unchanged; real callers `tabs.backActive` / `tabs.forwardActive`) | `/tmp/opencode/bar-nav-probe.py`: page link /a→/b enables Back; click Back → /a with Forward enabled; click Forward → /b |

**Verification:** `bun run typecheck` 0/0; `eslint` clean; `prettier --check`
clean; new `BarHover.component.test.ts` 2/2 (both event orders); packaged dev
build boots (`data-app-booted=true`) and `bar-probe.py` passes.

## Owner report: browser pages are tabs (2026-11-09)

**What changed:** Settings and the Extensions manager now wear their own row in
the tab list. Choosing a web tab parks the page instead of forcing a Back trip;
the page row stays in the list and choosing it returns to the page. Closing the
row dismisses the page. The same rule applies to every browser page when a tab
is chosen, and Work remains a mode that stays where it is. The Get button on
the Extensions page now opens its store tab in front immediately because the
page parks on the native active-tab change.

| Surface | Wiring / files | Live evidence |
|---|---|---|
| Page tab row | `ui/app/src/features/tabs/components/PageTabRow.svelte`, `lib/page-tab.ts`, `SidebarBody.svelte`, `TabRail.svelte`, `tab-icon.ts` | probe: Settings row exists and reads `aria-current=page`; row label `Settings`; page row appears in both rail and expanded list |
| Park / return | `ui/app/src/domain/surface/surface.svelte.ts` (`selected`, `pageTab`, `park`, `selectPage`, `dismiss`), `Shell.svelte` (`shownActiveId`, `selectTab`) | probe: click a web tab → `data-astra-surface=browse`; row remains; click the row → Settings returns |
| Extensions Get | same parking path; `WebExtensionManager` keeps `browserOpenUrl(url, true)` | probe: Extensions row → click Get → tabs 1→2, store tab shown at once, Extensions row stays parked |

**Verification:** `bun run typecheck` 0/0; `eslint` clean; `stylelint` clean;
`prettier --check` clean; 1246 unit tests pass (2 environment skips); 77
component tests across tabs/sidebar/Settings; live probe
`/tmp/opencode/page-tab-probe.py` 14/14 on the packaged dev build.

**Limit:** the page row is a chrome tab, not a native web tab: it does not
persist across restart and is not draggable or split-capable.

## Owner change: Work is off for Beta 1 (2026-11-09)

Work is a build-time product flag now, not a user switch (D-48).
`ui/app/src/shared/flags.ts` reads `VITE_ASTRA_WORK`; only `"true"` turns it
on and the shipped build does not set it. With the flag off the Browse/Work
rail switch, the Work canvas, the Work Settings page, its Features switch, the
`work.enabled` search entry, the onboarding Work demo and any `browser.work`
navigation are absent — not disabled. A profile that stored
`work.enabled=true` in an earlier build stays off. The runtime preference
remains for the build that ships Work, but cannot override the flag. Develop
Work with `VITE_ASTRA_WORK=true` (the Vitest projects set it). Verification:
`shared/flags.test.ts` and `features/settings/tests/work-flag.test.ts`; live
`tools/marionette-probe/work-off-probe.py` PASS — no rail switch,
`browser.work` leaves the surface on Browse, Settings groups are
Browser/AI/App and Features offers only AI, Notes, Tasks and Time.

## Owner report: PiP returns to its tab (2026-11-10, latest)

**What changed:** A media PiP player is a detour from the page, not a second
home. Selecting the tab it was cloned from now closes the player and the video
keeps playing inline. The engine already did this for the player it opens by
itself when a playing tab is left (`TabSelect` → `unpipAutoPipBrowser`); a
player opened from the Now playing card was not in that map, so it stayed over
the page after the tab came back. The host now runs the same foreground close
through the player's own `closeFromForeground` path (no Pause is sent) whenever
a real selection change brings a PiP source tab (or any pane of a selected
split) back. A redundant model re-assertion of the tab that is already in front
does not close it: that re-selection happens while playback and the card update,
and treating it as a return closed the player the moment it opened.

The automatic request had a second failure: it can reach the parent after the
person already returned (or finish opening while the return lands), so no tab
selection was left to close it and it opened as an unmarked manual player. The
request now carries its origin: an automatic request is dropped when its tab is
already selected or already active, and a player that finishes opening after the
return closes itself through the same foreground path. A duplicate hidden edge
cannot open a second player for the same browser (the auto actor map holds one).
Astra's card request is a separate message, so a player asked for while the tab
is in front still opens.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Card player return | opening the player from the Now playing card, leaving the tab, then selecting the tab closes the popup | `overlay/astra/host/Content.sys.mjs` (`closeForegroundPip`, `selectTab`, `onSelect`) | `pip-foreground-probe.py` PASS: 1 window while away, 0 after the return |
| Auto-PiP return | the engine's own auto-PiP closes on the same return; the host path is a no-op when the engine already closed it | same file; engine `unpipAutoPipBrowser` | same probe: window open on leave, closed on return |
| Late auto request | a request that loses the return race, or finishes after it, leaves no player over the tab; a duplicate hidden edge opens only one | `patches/ASTRA-0013-float-astra-pip.patch` (`autoRequest`, `AstraToggle`, `autoRequestInFlight`, `hasPipPlayerFor`) | same probe: 3 consecutive PASS, no window after the race |
| Playback continuity | the page keeps playing after the player closes, the native tab marker clears and the card drops `in_pip` | player `closeFromForeground` → `closeSinglePipWindow` (`Foregrounded`, no Pause) | same probe: `controller.isPlaying` true, marker gone, card `in_pip:false` |
| Redundant selection | re-selecting the tab already in front (model re-assert) leaves the player alone | `selectTab` (`wasSelected`) | same probe: player still open after a redundant `Tabs.select` |

**Verification:** `node tests/contract/tab_lifecycle.mjs` 17/17,
`media_model.mjs` 58/58, `media_selection.mjs` 10/10, `hostapi_v1.mjs` 336
checks, `wire_coverage.mjs` 50/50; live `pip-foreground-probe.py` PASS on
Hyprland (card, automatic, late-request paths; three consecutive runs);
`pip-minimize-probe.py`, `now-playing-probe.py` and `pip-player-probe.py` still
PASS; `forge lint` 13/13, `state-check` and `brand-lint` clean; overlay staged
and `build --faster` clean.

**Limit:** the player is closed only on a real foreground transition, matching
the engine's own auto-PiP rule. Clicking the tab row that is already selected
while its player is open re-asserts the same selection and keeps the player;
the player's own close/minimize control (or the card's PiP control) remains the
way to dismiss it in that state.

**Limit:** the player is closed only on a real foreground transition, matching
the engine's own auto-PiP rule. Clicking the tab row that is already selected
while its player is open re-asserts the same selection and keeps the player;
the player's own close/minimize control (or the card's PiP control) remains the
way to dismiss it in that state.

## Owner report: PiP minimize — popup away, playback stays (2026-11-10, latest)

**What changed:** Astra's PiP player has a minimize control beside the native
close. It runs the engine's own unpip-without-pause close path (the same path
Shift+close takes), so the popup closes and the originating tab keeps playing.
A native `window.minimize()` was tried first and is not the answer: Hyprland
ignores it for the always-on-top dependent dialog (measured `windowState` stayed
`1`, never `STATE_MINIMIZED`), and the player cannot hide itself without
closing. Closing the player is the safe path. The engine records the
unpip-without-pause close and suppresses auto-PiP for that browser until its tab
is selected again, so the hidden source cannot reopen the window immediately.
The source docshell stays active while the clone is open; parking it fires
`VideoTabHidden` and freezes the clone. The sidebar's
`in_pip` state comes from the engine's own tab marker through a per-tab
`MutationObserver` (the PiP code sets the attribute directly, so no
`TabAttrModified` arrives); the card's PiP control raises an already-open
player rather than opening a second one. The card itself no longer drops just
because the controller deactivated or its title had not arrived: an audible or
playing tab keeps the card, and the native `soundplaying`/`muted` attributes
refresh the projection when the controller drops an event.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Minimize | closes the popup, leaves the tab unpiped and the media playing; no Pause is sent | `overlay/astra/pip/PipPlayer.sys.mjs` (`astra-pip-min` → `#close` with `shiftKey`), `overlay/astra/chrome/pip/player.css` | `pip-minimize-probe.py` PASS: player closed, tab marker gone, `controller.isPlaying` still true |
| Restore | the card's PiP control reopens the player after minimize, or raises an open one | `overlay/astra/host/Content.sys.mjs` (`findPipWindow`, `picture_in_picture`), `MediaPlayer.svelte` (`Show player`) | same probe: second window opened from the card; `pip-player-probe.py` PASS |
| State | `in_pip` follows the native `pictureinpicture` tab attribute open/close; the player's window map is the only source | `Content.sys.mjs` (`pipObserver`, `attachMedia`, `detachMedia`) | same probe: `in_pip=true` while open, `false` after minimize |
| Tab switch | a PiP source stays active while its player is open, so a tab switch and the model update that follows it do not close or re-park the player | `Content.sys.mjs` (`isPictureInPictureSource`, `applyTabActivation`), engine auto-PiP (`docShellIsActive`) | same probe: switching to a silent tab keeps one window, the card stays on the source and `docShellIsActive` stays true |
| Now playing | a playing or audible tab keeps the card when the controller is inactive or the title is still empty; `soundplaying`/`muted` attribute changes refresh it | `Content.sys.mjs` (`mediaView`, `attachMedia` `state.refresh`, `onAttr`) | `now-playing-probe.py` PASS: card named, silent switch kept it, newer playback took it, close stuck, pause kept it |

**Verification:** `node tests/contract/tab_lifecycle.mjs` 17/17,
`media_model.mjs` 58/58, `media_selection.mjs` 10/10, `hostapi_v1.mjs` 336
checks, `wire_coverage.mjs` 50/50; `bun run typecheck` 0 errors/warnings;
media component tests 9/9; `forge lint` 13/13, `state-check` and `brand-lint`
clean; live `pip-minimize-probe.py` PASS, `now-playing-probe.py` PASS and
`pip-player-probe.py` PASS on Hyprland.

**Limit:** the live clip is generated VP8/Opus and the proof is the media
controller's `isPlaying` across the close, not a speaker measurement. Minimize
is an unpip (the player window closes), not an OS-iconified window; the card's
PiP control is the restore path inside Astra, and the site's own PiP control
also returns. The source docshell stays active while the player is open;
closing it re-parks the source, and the engine suppresses auto-PiP for that
browser until its tab is selected again. The cost is the hidden tab's layer
while the player is open; after minimize the hidden page parks as usual.

## Owner report: Now playing + Astra picture-in-picture (2026-11-09)

**What changed:** the sidebar's Now playing card was one shared projection, so
every tab's media event overwrote it and a silent tab's `null` view could clear
a playing one. Content now chooses one tab from the live controllers (newest
playback first; the current tab while nothing plays), projects only that, and
keeps a suppressed card closed until its tab starts playing again. The tab
audio flag was read from `browser.audioPlaybackActive`, which this engine does
not have, so the rail's media list stayed empty; it now reads the native
`tab.soundPlaying` and the controller's `isAudible`.

**Picture-in-picture:** the engine's media PiP window now opens as a dependent
dialog from its opener on Linux. A tiling Wayland compositor floats a transient
dialog instead of giving it a tile (Hyprland proof: `floating: true`, 640×360).
Astra's `PipPlayer` module adds the player stylesheet, copies the interface's
light/dark theme and follows changes live, and puts the site title in a slim
head strip. The video, scrubber, transport, resize margins and always-on-top
behavior are still Gecko's own; every observer, listener and injected node is
released on the player's unload.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Now playing picker | silent tab cannot clear a playing one; newest playback takes the card; paused card stays; close sticks until that tab plays again | `overlay/astra/host/MediaSelection.sys.mjs`, `Content.sys.mjs` (`projectCurrentMedia`, `mediaSuppressed`) | `tests/contract/media_selection.mjs` 10/10; `now-playing-probe.py` PASS: card named, silent switch kept, second tone took it, close stuck, pause kept it, no card after close |
| Rail audio | the media list marks a playing tab and its item projection carries `audio` | `Content.sys.mjs` (`projectAudible` → `tab.soundPlaying` / `controller.isAudible`) | same probe: `audible: true`, `items-changed` had 2 audio rows |
| Floating PiP | opens as a dependent dialog, floater under Hyprland, aspect-locked and resizable by the native margins | `patches/ASTRA-0013-float-astra-pip.patch` (`PLAYER_FEATURES`, `parentWin.open`) | `pip-player-probe.py`: `hyprctl` `floating: true`, size 640×360 |
| Astra player face | Astra stylesheet (resource URL; a chrome-provider CSS inside a chrome://global document loads empty), head strip with the site title, theme follows the interface live | `overlay/astra/pip/PipPlayer.sys.mjs`, `overlay/astra/chrome/pip/player.css`, `jar.mn`, `player.xhtml` link | same probe: `resource://astra/pip/player.css` 24 rules, `data-astra-pip`, head “Astra”, dark→light→dark followed live, Astra ground painted |
| Resources | one observer + one title listener per player window; stylesheet/head removed on unload; no new wire command or event | same files | probe closes the window with no residue; `media_model` 58/58; `hostapi_v1` 327/327; `wire_coverage` 50/50 |

**Verification:** `node tests/contract/media_selection.mjs` 10/10, `media_model`
58/58, `hostapi_v1` 327/327, `wire_coverage` 50/50, `bun run --filter
@astra/frame check` 1246 passed / 2 environment skips, `forge lint` 13/13 clean,
`state-check` and `brand-lint` clean; live `now-playing-probe.py` and
`pip-player-probe.py` PASS on Hyprland. Patch: `ASTRA-0013` applies and
reverse-checks against baseline `61e41ec4`.

**Limit:** `forge footprint` is already over its 1500-line P2/P3 budget on this
branch (ASTRA-0004 alone is 2235 lines); this change adds 49 patch lines. The
PiP floating proof needs a tiling compositor; under the hidden Weston display
the Astra face is still checkable but the floater assertion is a reasoned SKIP.
`window.resizeTo` from the opener is ignored by the player (upstream behavior);
resizing is the native window's own edge/margin path, unchanged.

## Owner report: Astra extension manager and install prompt (2026-11-10, latest)

**What changed:** the engine's "Add <extension>" doorhanger is gone. The shell
hooks the window's `PopupNotifications.show` for `addon-webext-permissions`
and publishes the same prompt to Astra's sheet, including the required
permission list, the unsigned warning and the optional private-window and
technical/interaction-data choices. `web_extension_answer_prompt` resolves the
engine promise. Astra's own review answers the prompt silently when it already
listed the permissions, so an install stays one confirmation.

The sidebar's utility bar now carries an Extensions control at the top. Its
menu offers Manage extensions, the Chrome Web Store, Firefox Add-ons and
install-from-file; the manager page offers the two stores side by side, and gives every installed extension its
on/off switch, pin, site access, options and an Open control. The Open control
(and a pinned button) runs the extension's own action: browser actions are
projected as `extension-actions-changed`, and `extension_action_invoke` opens
the popup in an Astra panel anchored at the app button, never the native
unified-extensions panel.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Install prompt | AMO/engine install prompt appears in Astra's sheet with permissions and optional choices; native doorhanger stays absent; Add installs through `AddonManager` | `overlay/astra/host/WebExtensions.sys.mjs` (`install`, `permissionPrompt`, `answerPrompt`), `ui/shell/src/Shell.svelte`, `WebExtensionInstallPrompt.svelte`, new `web-extension-prompt-changed` / `web_extension_answer_prompt` | `tools/perf/stress/webext_prompt_probe.py`: sheet rendered, 2 permission rows, native notification absent, Add installed `prompt-probe@astra.test` |
| Manager entry | top-of-sidebar Extensions control opens the page; page offers both stores | `UtilityBar.svelte`, `WebExtensionManager.svelte`, `bindings.ts` | `tools/perf/stress/webext_ui_probe.py`: Extensions button present, `.library-shell` in front, both store labels |
| Row controls | on/off, pin, open, options, site access, remove | `ExtensionRow.svelte`, `ExtensionManager`, `webext.svelte.ts` | same probe: row, switch, pin (`aria-pressed=true`), extension popup opened |
| Action projection | browser actions reach the app with label/badge/icon/popup flag; pinned button also invokes | `WebExtensions.sys.mjs` (`actionsForWindow`, `invokeAction`, `openActionPopup`), `chrome-entry/browser-chrome.ts`, `domain/extensions` | `tools/perf/stress/webext_action_probe.py`: action projected, popup loaded `moz-extension://…/popup.html`, native panel closed, panel released |

**Verification:** `bun run --filter @astra/frame check` (typecheck, eslint,
stylelint, prettier, knip, 1249 unit tests / 2 environment skips); component
suites 33/33; `webext_view` 28/28, `chrome_extensions` 39/39, `wire_coverage`
50/50, `hostapi_v1` 341, `native_surfaces` 125/125, `settings_native` 105;
`crates/astra-proto/check-drift.sh` clean (276 commands / 36 events); live
`webext_prompt_probe.py`, `webext_action_probe.py` and `webext_ui_probe.py`
PASS on the packaged dev build; `webext_probe.py` still PASS (install, list,
disable/enable, options, uninstall).

**Teardown:** the shell restores the original `PopupNotifications.show` and
removes the window from the action set on unload; unresolved prompts answer
cancel; action popups destroy their temporary panel and browser on hide.

**Deferred:** update/sideload permission prompts still originate from the
engine's app-menu notification path; they are not opened by any Astra surface
today. Page actions are not projected (browser actions are). A private-window
action is projected only for the window that owns it.

## Owner report: top bar utilities — extensions, appearance, sleeping (2026-11-09)

**What changed:** the column head now carries every utility in one row: media,
downloads, notes, spaces, sleeping pages, extensions and a quick appearance
switch. Sleeping pages use one `zzz` mark everywhere (rail entry, tab rows,
essential tiles, sleeping badge) instead of the moon, which now means light and
dark. The extension door opens a real hub: every installed extension with its
live action for the page in front, an enable switch, options, pin/unpin and
removal with confirmation, plus install-from-file, store and manage entries.
The hub loads on first open, not with the column's startup. The bar reflows to
a grid at the column's narrow widths and its 24px plate step below 196px.

| Surface | What works | Wiring / files | Verification |
|---|---|---|---|
| Top bar | Extensions and appearance entries beside the existing five; the row follows the column's width with container queries | `features/rail/components/UtilityBar.svelte`, `SidebarHeader.svelte`, `Sidebar.svelte`, `favicon.css`, `shared/ui/FavIcon` | `UtilityBar.component.test.ts` 16 tests; narrow reflow case |
| Appearance switch | One click writes `appearance` (light ↔ dark) through the preferences store; System resolves to what the window shows | `preferences.set("appearance", …)`, same push path as Settings → Appearance | two component tests; icon/name follows the resolved mode |
| Sleeping mark | `zzz` on the rail entry, tab rows, rail rows, essentials and the sleeping badge; site mark steps back rather than disappears | `FavIcon` `sleeping` prop, `favicon.css`, `TabRow`, `TabRail`, `EssentialTile`, `TabsSleepingBadge` | `FavIcon.component.test.ts` 2 tests; sleeping badge suite |
| Extension hub | Live actions, switch, options, pin, remove-confirm, install file, store, manage; empty state has both ways to add | `features/extensions/components/ExtensionHub.svelte`, `loadExtensionHub()`, existing `webExtension*` routes and `surface.open("extensions")` | `ExtensionHub.component.test.ts` 5 tests; `UtilityBar` extension-entry test |

**Verification:** typecheck 0; full unit suite 1241 passed / 2 skipped; targeted
component 28 passed; stylelint and eslint clean on the touched files.

**Limit:** live Marionette verification is deferred. On this branch's base
commit (`e58be029`) `bun run --filter @astra/frame build` already fails at
`browser startup requests exceed the native asset budget: 39 (limit 24)`;
the same failure reproduces with this work stashed. The feature adds no startup
chunk (the hub is a lazy destination). No live claim is made for this surface.

## Owner report: extension platform — Chrome CRX3 + Firefox XPI (2026-11-08, latest)

**What changed:** Chrome packages are a real extension source next to signed
Firefox XPI. `astra-core` (Rust) verifies the CRX3 RSA proof and ZIP digest,
unpacks with traversal/size/ratio bounds, adapts the manifest to Gecko 153,
inventories the APIs the package calls, scans behavioural signals, and writes
a deterministic XPI. The Host API installs that exact XPI through the engine's
own `AddonManager`, records the package/report hashes, and restores session
packages at startup. The UI's existing Chrome Web Store Add button now reaches
this path; the review shows source, signature, verdict, limitations, security
evidence and whether the package survives a restart.

| Surface | What works | Wiring / files | Live evidence |
|---|---|---|---|
| Chrome package intake | CRX3 signature + id from key, CRX2/ECDSA refusal, safe ZIP, 96 MiB/512 MiB bounds, traversal/symlink/duplicate refusal | `crates/astra-extensions/src/{crx,package,pipeline,security,manifest,compat}.rs`; `astra-core` `extensions.inspect`/`extensions.stage` | Rust 41+1 tests; `chrome_ext_probe.py` 55/55; inspect 2.2 ms |
| Manifest adaptation | MV3 worker → event page, static `importScripts` expanded, `side_panel` → `sidebar_action`, MV3 callback prelude, unsupported permissions removed and reported, stable `<chrome-id>@chrome.astra` id | `manifest.rs`, `compat.rs`, `jar.mn` | probe checks adapted bg/sidebar/permissions and fault containment; real Tampermonkey 1024-bit key verifies; 55-package corpus 55/55 |
| Lifecycle | install, update (same id, version 1.1.0), disable/enable, restart restore, uninstall, record/package cleanup | `overlay/astra/host/ChromeExtensions.sys.mjs`, `WebExtensions.sys.mjs` | probe: update/restart/disable/enable/uninstall and a crashing extension all pass; 3-cycle PSS growth 10.2 MiB |
| Store + file | Always-visible top-of-sidebar “Add to Astra” on a store listing (the store says “Switch to Chrome”; Astra installs it itself); `.crx`/`.zip` file and drop; signed `.xpi` unchanged | `StoreInstallBanner.svelte`, `storeIdFromUrl`, `downloadCrx`, `prepare`, `prepareFile`, `chooseFile` | visible live run 5/5 from store pages; real packages 57/57 |
| Security | lexical evidence with file/line; proximity combinations; auto-block only miner+exfiltration/privilege; clean ≠ safe | `security.rs`; review `security` block | malicious fixture blocked before staging; tampered CRX and traversal ZIP refused |
| UI | source + signature line, compatibility badge, limitations, security evidence list, persistence line; row source/security marker | `WebExtensionReview.svelte`, `ExtensionRow.svelte`, `bindings.ts`, `messages/en.json` | typecheck 0, webext unit/component 21 tests |

**Verification:** `cargo test -p astra-extensions` 41+1; `node
tests/contract/chrome_extensions.mjs` 39; `chrome_ext_probe.py` 55/55;
`real_extensions_probe.py` 57/57 on 5 real packages; `extension_corpus_probe.py` 55/55 on the broad corpus; visible live store run 5/5;
`extension_bench.py` PASS (startup 1.85 s, idle CPU 4.9 %, 60 s PSS growth
24.7 MiB, 3-cycle 10.2 MiB). Evidence in `out/chrome-ext/`,
`out/real-extensions/`, `out/extension-bench/`.

**Limit:** this build requires Mozilla signatures, so an adapted Chrome XPI is
installed as a temporary add-on and restored at each start; it does not use
AMO's update channel. MV3 service workers run as event pages; true worker
globals, dynamic `importScripts` and Chrome-only APIs (`debugger`,
`offscreen`, `tabCapture`, `system.*`, …) remain unsupported. The store
acquisition endpoint is not an official API. Full contract and limitations:
`docs/astra/EXTENSIONS_COMPAT.md`.

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
| Split view | 1–3 native panes (a fourth is refused), one resizer per boundary, all panes active, replace/leave, drag-to-edge, save/restore, background tabs load when split | `overlay/astra/host/SplitView.sys.mjs`, route table (`tabs_split`/`tabs_unsplit`/`tabs_leave_split`/`split_*`), `Content.sys.mjs` binds the native map, `Tabs.__setSplitGroup` projection, `ui/app/src/features/split`, tab menu, `tab-menu.ts` | `native-surfaces-probe.py`: 2 panes on Wikipedia + MDN, widths 244/421 after ratio, 3 panes live, arrangement restores 3, drop accepted, replace keeps 2 |
| Native groups | Handles, collapse, ungroup and sidebar headings for engine tab groups | `TabGroups.sys.mjs`, `tabs.group_*` routes, `TabView.group`, `sidebar-model.ts` group units, `TabList` headings | probe: group created, both members projected, `.tab-group-head` drawn |
| Peek | Window-like popup: real capture, close, bookmark, open as tab/split, hover/shift/menu, independent cards, restore, settings | `Peek.sys.mjs`, `peek_*` routes, `$domain/peek`, `PeekLayer.svelte`, `peek-changed` channel, Tabs/Bookmarks hover timers | probe: 31 kB PNG capture of Wikipedia, `.peek-window` drawn above the page with an inset clip, bookmark/open-tab/open-split actions; page/link context menus offer preview and open-in-split; closing frees the capture |
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
PASS; `wire_coverage` PASS; live probe 44/44 on Wikipedia, MDN and IANA.
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

## Owner report: Home lands on the New Tab (2026-11-15)

| Surface | Fix | Wiring / files | Live evidence |
|---|---|---|---|
| Home button | Clicking Home from a page left the old page in front with the tab spinning forever. The blank-stage load called `browser.loadURI("about:blank", …)`, but ESR 153's `nsIWebNavigation.loadURI` takes an `nsIURI`, not a string: the call threw, the error was swallowed, and neither `nav.committed` nor the `busy` edge ever settled the tab. The blank stage now loads through `fixupAndLoadURIString`, and asking for the New Tab when it is already the current head is a settled no-op instead of a load nothing can finish. | `overlay/astra/host/Content.sys.mjs` (`loadIn` blank branch), `overlay/astra/host/Navigation.sys.mjs` (`loadURL` blank no-op) | `tests/contract/zoom_home_material.mjs` (47 checks, incl. the settled no-op); Windows dev-build Marionette: Home from a loopback page → `about:blank`, New Tab surface, favicon spinner gone at 0.5 s; Home again on the New Tab → no spinner. `tools/marionette-probe/material-zoom-home-probe.py` now checks both |

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
- **The remaining unrouted command ids.** 182 of the 317 wire names have a Host
  route; 135 have none. The count and every gap now live in
  `ui/packages/bridge/src/manifest.ts` (D-55), not in prose:
  `node tests/contract/wire_manifest.mjs --report` writes
  `tests/contract/wire_gaps.json` with the state of each gap.
  110 are deferred by decision (D-48 Work 53, SCOPE accounts 28, D-54 AI 29),
  25 are unused (dead registrations plus the removed divider overlay, panel
  intents, haptics and native-swipe callers), and 0 are open defects.
  `tests/contract/wire_manifest.mjs` fails when a `proto.ts` command has no
  manifest row, and `tests/contract/wire_coverage.mjs` fails when a route
  target does not exist or an imported host module is not in `jar.mn`.
  Close a deferred row when its decision lifts: a UI caller, a `routed` row in
  the manifest, a contract test and a live probe.
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

### Wire record: Back/Forward history menu (2026-11-10)

- `tabs_history` → `TabHistory.list` and `tabs_history_go` →
  `Navigation.goToHistory`; both map the app's `id` onto `astra_tab_id`.
- New `TabHistory.sys.mjs` host module. `Content.mountNative` installs its
  driver over `SessionStore.getSessionHistory(tab)` and clears it on detach.
- `Navigation.goToHistory` steps the model stack and commits with
  `history: "back" | "forward"` plus the new `history_index` event field, which
  `Content` consumes to call `browser.gotoIndex(index)`.
- Why: the native `history_menu_popup` had no route, so a right-click or held
  press on Back/Forward did nothing; the menu is now drawn in the app and each
  row answers with a real session-history jump.

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

P7–P11 all `todo` — see `docs/planning/PLAN.md` §§8–11.

## Native binding merge (2026-11-04)

Execution plan and phase status: `docs/planning/MERGE.md`. The new wire shapes below are
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

## Audit note: verification gates and stale counts (2026-11-20)

> Added by the gate-repair lane of the full-product E2E audit. This is the only
> edit to STATE.md in that lane; the rows above are untouched.

- **Unrouted commands (corrects "200 of the 270" above):** the registry held
  **278** command names with **141** unrouted when the audit was stamped, not
  200 of 270 (279/140 a little later, as routes kept landing). The baseline is
  now derived (`node tests/contract/wire_coverage.mjs --write-baseline`), and
  the guard fails if a baseline entry is routed or is not a command, so the
  number can be trusted even while it moves.
- **Split / drag-drop / menus / downloads / media import** in that same bullet
  are routed and shipped; the remaining unrouted names are account, Work,
  page assist, voice, page styles, profiles-menu leftovers, updates and
  onboarding, plus the dead `divider_*`/`*_menu_popup` sends.
- **Sidebar width:** this file and `UI_REFRESH.md` still cite a 240 px expanded
  column; the code floors it at 252 px (`MIN_EXPANDED_WIDTH`) and the legacy
  probe measured 260 px. `utility-bar-probe.py` is unregistered until its
  geometry assertions are rewritten.
- **The gate:** `tools/perf/full-suite.sh` registers every `tests/contract/*.mjs`
  (an unregistered suite fails), and `tools/perf/full-suite.ps1` runs the same
  gates on Windows. Registered is not everything: stale probes are listed in
  `out/audit/findings/probes.md`. `docs/astra/TESTING.md` states what a PASS
  covers.
- Details, before/after counts and changed files:
  `out/audit/fixes/gates.md`.
  Audit: `docs/astra/E2E_AUDIT_2026-11-20.md`.

## Page dialogs — ASTRA-0020 (2026-11-20, audit fix lane)

- A page's `alert`/`confirm`/`prompt`/`beforeunload` are drawn by the app, not
  by `chrome://global/content/commonDialog.xhtml` (fuzz F1/F3, P1).
  `patches/ASTRA-0020-astra-page-dialogs.patch` (engine actor),
  `overlay/astra/host/PageDialogs.sys.mjs` (controller), the window hook in
  `Boot.sys.mjs`, `PageDialogPrompt.svelte`, and the host route
  `page_dialog_answer` + event `page-dialog-prompt-changed`.
- **Generated-binding gap:** `bindings.ts`/`proto.ts` have no generator in this
  checkout, so the one command and one event were added by hand, mirroring the
  surrounding entries: `pageDialogAnswer(...)` in `commands`,
  `pageDialogPromptChanged` in `events`, `PageDialogKind` /
  `PageDialogPromptChanged` types, and `page_dialog_answer` /
  `page-dialog-prompt-changed` in `proto.ts` (counts updated). Replace them
  with `astra-proto` output when the generator lands.
- Verification: `page_dialogs` 54, `dialogs_events` 104, `wire_coverage` 69
  (baseline regenerated), `boot_model` 31; patch applies with
  `git -C engine apply --check`. Live: `out/audit/fixes/page-dialogs.md`.

## Gallery (2026-11-20)

- **Surface:** the rail's Gallery entry (next to Downloads) opens a full page
  that indexes pictures in Downloads, Documents and Pictures, plus a `Gallery`
  folder when this machine has one. Search and a folder filter run over the
  cached index; clicking a tile opens a morphing viewer with previous/next,
  Escape/arrow keys, Copy, Show in folder, Manage folders, and the OS handler
  name (`Open in Photos`). Settings -> Gallery lists the folders, adds and
  removes them, restores defaults, and warns that more folders cost time and
  memory.
- **Wiring:** route `media_gallery` -> `MediaGallery.call`
  (`overlay/astra/host/MediaGallery.sys.mjs`) with `GalleryCall` /
  `GalleryResponse`. `browser.gallery` and `settings.section.gallery` were
  added to `Commands.sys.mjs`; the page is a `BrowserPage` branch in the shell.
- **Wire shape reason (SCOPE rule 5):** there was no generic gallery route and
  reusing `media_import` would make a read-only local index look like an import.
  The row was added to `docs/astra/ipc-surface.md`, `generate.py` now pins 279
  commands, and `validate.py` was updated. `bindings.ts` has no Specta generator
  in this checkout, so `mediaGallery(...)` and the gallery types were added by
  hand next to `mediaImport`, as the page-dialog entry above already did.
- **Cost controls:** asynchronous `IOUtils` walk in bounded batches (depth 2,
  96 folders, 1500 pictures, 8 s); partial results stream while scanning; the
  result is cached for 30 s; thumbnails are decoded only for visible tiles,
  resized by the decoder, encoded to WebP, cached under
  `<ProfD>/astra-gallery-thumbs` (480 files / 64 MB, pruned) and kept in a
  24 MB in-memory LRU. The full original is never loaded by the grid.
- **Isolation:** private windows render a "not available" state and never call
  the module. Every file action validates its path against the active roots.
  A viewer render failure is contained by its own `svelte:boundary`.
- **Verification:** `tests/contract/media_gallery.mjs` 58 checks (defaults,
  Gallery detection, scan depth/skips/caps, search/filter/paging, enable,
  add/remove/restore, path refusal, thumbnails and headers); `wire_coverage`
  69; `astra-proto validate` PASS (279 commands); UI unit tests for the gallery
  model 8/8 and the rail component 19/19. Live probe
  `tools/marionette-probe/gallery-probe.py` **21/21** on the packaged Windows
  build (rail entry, four pictures, cached data-URL previews, search, viewer,
  arrows, Escape, settings warning and folder row). Screenshots:
  `out/gallery-probe/{grid,viewer,settings}.png`.
- **Deferred:** video and audio are not indexed (pictures only). A filesystem
  watcher is not installed; a new file appears on the next open after the 30 s
  cache or on Refresh. The probe used a scratch folder with the default folders
  excluded so its result is stable; the default rows were verified separately
  in the contract test.

## Downloads: completed history and deleted files (2026-11-20)

The owner reported that downloads were not stored or visible in the viewer,
and asked for a file that no longer exists to be marked deleted. The engine
keeps only in-progress/partial downloads in its session list; on Desktop the
completed ones are written to Places history. The host was reading only
`Downloads.PUBLIC`, so a finished download disappeared on restart.

| Fix | What changed | Verification |
|---|---|---|
| Durable list | `Downloads.sys.mjs` reads `DownloadHistory.getList({ type: Downloads.PUBLIC, maxHistoryResults: 300 })`, merging current transfers with completed history. `updates` returns the same merged set. | `downloads_model` 140/140; live `downloads-history-probe.py` 10/10 across a real quit/relaunch |
| Target and deletion | `DownloadView` gains optional `target`, `exists` and `deleted`. `list` checks each completed target with `IOUtils.exists` (forced fresh on a page load); a missing or browser-deleted file is `exists:false, deleted:true`. `updates` uses a 2.5 s cache so a progress burst does not stat the history. | `downloads-lifecycle-probe.py` 18/18 (completion, target, file on disk, delete -> marked); component test `DownloadsList` 16/16 |
| Viewer | A completed deleted row is not an Open button. It says `Deleted from <folder>` with the deleted-help tooltip, keeps Show in folder (the folder, not the missing file), and is marked `data-deleted`. The status card also shows Deleted. | live viewer check in `downloads-history-probe.py`; `DownloadsList.component.test.ts` deleted-row test |
| Forget / clear | `forget` and `clear` remove the session entry and its Places history row (never the file). History downloads are no longer invisible to those verbs. | `downloads_model` command checks; live discard path unchanged |
| Open / reveal | Both resolve the target path. Open refuses a missing file; reveal opens the containing folder when the file is gone. Pause/resume/keep are restricted to session transfers. | `downloads-lifecycle-probe.py`; contract checks |

**Wire note (SCOPE rule 5):** the three `DownloadView` fields are an optional
extension in `ui/app/src/shared/ipc/bindings.ts` (there is no Specta generator
in this checkout); responses include them, older fixtures may omit them.

**Deferred:** the list keeps the newest 300 history entries. `clear` removes the
download's Places URL visit, matching Firefox's own download deletion. The
private-window public-list policy is unchanged.

## Phase 7 - IPC architecture (from 2026-11-22)

The architecture review of 2026-11-22 found five lists describing the command
wire that disagree (281 bindings, 279 generated, 281 hand copy, 177 routes, a
140-gap baseline) and a guard that parses TypeScript with a regular expression.
This phase gives the wire one owner. Decisions: D-54, D-55.

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P7-T01 | One command manifest owns the wire | doing | opencode | refactor/command-manifest | Complete: the manifest owns 317 names. 182 routed — the 12 open rows were closed: `essentials_keep`/`release` -> `Tabs.keepSite`/`releaseSite` (a host catalog drift-checked against the app's), `update_highlights`/`update_relaunch` -> honest `System` answers, `resource_close_ready` -> the new `Close` handshake, and the divider overlay, panel intents, haptics and native-swipe callers removed with the evidence that nothing produces them. 110 deferred by decision (D-48 53, SCOPE 28, D-54 29); 25 unused; 0 open. Live: headed-probe 10/10, split-view-probe 30/30, wire-completion-probe 10/10 (split panes + close handshake in 0.92 s). Verified: wire_coverage 65, wire_manifest 13, bridge 31, contracts green except the two pre-existing red, vitest 1278, svelte-check 0. Next: the mock's default answer, then the deferred clusters as their decisions lift. |
