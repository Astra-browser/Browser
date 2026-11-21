# Blocker — Brave engine, native hook, Astra UI

> Status: **live** (D-42, 2026-11-07). Source of truth: `blocker/`.
> Supersedes the "native_unsupported / unavailable" state documented in the
> 2026-11-02 `BLOCKER_WIRING.md` draft. That document is kept for patch-series
> background and its open-build checklist is now closed.

## What the person can do

- Ads, trackers, malware and optional annoyances are blocked inside every
  normal and private window. Network requests are cancelled before they leave
  and matching page elements are hidden.
- The shield in the page bar reports the real state and pauses the current
  site. Private windows block the same way but record no counts.
- Settings → Privacy → **Ad, tracker and malware protection** shows the full
  catalog (80 lists), which are enabled, the compiled rule count, last/next
  update, the schedule, element-hiding and scriptlet switches, and the bounded
  counters with a reset action.
- "Update lists now" fetches the enabled sources, validates them, recompiles
  once and keeps the previous engine if anything fails. The scheduler does the
  same every N hours (default 24) and catches up on the next start.

## Shields features (native, 2026-11-07)

| Feature | Native mechanism | Setting |
|---|---|---|
| `$removeparam` | adblock-rust returns `rewritten_url`; the channel hook redirects before connect | Strip tracking parameters |
| `$redirect` resource substitution | adblock-rust returns the resource as a `data:` URI; the hook redirects the channel and marks the loadInfo data-URI allowance | Redirect placeholders |
| Bounce/debounce unwrapping | native redirector table + query unwrap in Rust; top-level navigation redirects directly | Unwrap tracking links |
| CNAME uncloaking | Host resolves a host's canonical DNS name, classifies it with the live engine, and marks the first-party host; the hook blocks later requests | CNAME uncloaking |
| Block Scripts | the hook cancels `script` requests globally or for one site | Block scripts / per-site shield |
| Standard / Aggressive | list preset plus aggressive social-embed blocking; per-site Aggressive also forces removeparam/bounce | Protection mode |
| Per-site shield | `setSitePolicy(host, enabled, aggressive, scripts)` in the Rust engine, persisted by the Host | Shield menu |
| Custom filter-list URL | HTTPS source added to the bundle and cached like a catalog list | Custom filter lists |
| Custom rules | user rule text appended after every list | Your filter rules |
| Social embeds + cookie banners | `social-media-blocker`, `easylist-cookie` and `ublock-filters-cookie-notices` are default-enabled | Filter lists |
| Third-party cookies | `network.cookie.cookieBehavior` (allow / block / partition) | Cookies and site data |
| Forgetful browsing | `nsIClearDataService.deleteDataFromHost(CLEAR_FORGET_ABOUT_SITE)` on last tab close | Forget me when I close this site |
| Per-site cookie controls | cookie permission (`nsICookiePermission.ACCESS_DENY/ALLOW`) | Shield menu |
| Ephemeral third-party storage | partitioned third-party storage + purge on close | Ephemeral third-party storage |
| Fingerprinting modes | FPP target set; per-site `privacy.fingerprintingProtection.granularOverrides` | Fingerprinting protection |
| Language spoofing | `+JSLocale/+JSLocalePrompt` and an Accept-Language header override | Language fingerprinting |
| Screen spoofing | `+ScreenRect,+ScreenAvailRect,+ScreenPixelDepth,+CSSDeviceSize,+CSSResolution` | Screen fingerprinting |
| Full API coverage | Aggressive mode uses the full FPP target set (canvas, audio, WebGL, fonts, display, timers, media and locale) | Fingerprinting protection |

The per-site shield persists under `astra.blocker.site-policies`; the
fingerprint and cookie overrides persist under `astra.privacy.*`. Every switch
has a Host route and a Settings control; no setting is a dead toggle.

## Wiring (route → host → engine)

| Surface | Route | Host module | Native |
|---|---|---|---|
| Status/shield | `blocker_status` | `Blocker.status` | `nsIAstraBlockerService.status()` + `mozilla::AstraBlocker` |
| List catalog/settings | `blocker_lists` | `Blocker.lists` | service status + catalog JSON |
| Configure lists/schedule/switches | `blocker_configure` | `Blocker.configure` | pref writes + `installRules`/`setResources` |
| Update now | `blocker_refresh_sources` | `Blocker.refreshSources` | HTTPS fetch/cache + `installRules` |
| Stats/reset | `blocker_stats`, `blocker_reset_stats` | `Blocker.stats`, `Blocker.resetStats` | Rust counters |
| Site pause | `blocker_site_change` | `Blocker.siteChange` | `setSiteEnabled` |
| Cosmetic | (actor, not a UI route) | `AstraBlockerParent` → service | `cosmeticFor(url, classes, ids)` |
| Network verdict | (channel hook) | — | `AstraBlocker::ShouldBlockChannel` → Rust FFI |

### Native layers

- **`toolkit/components/astra_blocker_engine/src/lib.rs` (Rust).** Brave
  `adblock-rust` engine; rule compilation/replacement, scriptlet+redirect
  resources, cosmetic selectors, procedural payload, per-site switches and
  fixed-size counters. Fail-open on every error. Owned by Rust, guarded to the
  main thread.
- **`AstraBlocker.cpp` (C++ bridge).** Maps Gecko `ExtContentPolicyType` to
  adblock request types, skips browser-internal schemes and system-principal
  loads, detects private contexts, and calls the Rust verdict from
  `AsyncUrlChannelClassifier::CheckChannelHelper` before connect. This file is
  the only C++ policy code; the matching logic never moves.
- **`AstraBlockerService.cpp` + `nsIAstraBlockerService.idl`.** The XPCOM
  management seam chrome JS uses. It is deliberately thin: every method
  delegates to the Rust engine. `components.conf` registers it as a singleton
  at `@astra/blocker;1`.
- **`overlay/astra/host/Blocker.sys.mjs` (Host).** Catalog, on-disk cache,
  HTTPS fetch with a 30 s timeout and size caps, the `nsITimer` schedule,
  preference persistence and the status projection.
- **`overlay/astra/actors/AstraBlocker{Parent,Child}.sys.mjs` (actor).** The
  parent asks the engine for the page's selectors/script; the child injects CSS,
  runs the scriptlet payload and applies the common procedural actions. One
  observer/style/timer per document, torn down with it.

## Source of truth and rebuilds

`blocker/` → `forge overlay` → `engine/toolkit/components/astra_blocker_engine/`
+ `engine/astra/blocker/`. Patch bodies (`ASTRA-0003/0004/0005`) are generated
by `forge export`; the engine tree is fetched upstream and never committed.
Data files are generated by `blocker/tools/sync.py` from the four reference
clones under `folder_context/`. A future Firefox bump therefore needs only:
`forge fetch` → `forge overlay` → `forge export` (fixing hunk context if the
hook moved) → `forge build --jobs 2` → `blocker-probe.py`.

## Verification (2026-11-07, packaged dev build)

**Shields feature pass (later 2026-11-07).**
`tools/marionette-probe/shields-probe.py` PASS covers: `$removeparam` (server
sees the cleaned URL), `$redirect` (1×1 GIF, original URL never requested),
bounce unwrapping (Google redirector lands on the loopback destination), CNAME
enforcement from Gecko's async canonical name, per-site Block Scripts, custom
user rules, cookie modes, per-site cookie block/allow, forget-on-close data
clear, fingerprint target sets, Accept-Language spoofing and bounce-tracking
purge mode. `tests/contract/privacy_host.mjs` adds 22 checks over a fake chrome.

**Benchmark.** `tools/marionette-probe/adblock-benchmark-probe.py` reports
**132/132** on `https://adblock.turtlecute.org/` (128 hosts + 2 cosmetic + 2
script canaries), and YouTube playback with no `.ad-showing` and no visible ad
module across 24 one-second samples. Evidence: `out/adblock-benchmark/`
(`report.json`, `turtlecute.png`, `youtube.png`).

**YouTube scriptlets (2026-11-07, regression fix).** The resource bundle now
carries the generic uBlock Origin scriptlet set and its `.fn` dependencies from
`adblock-rust/data/brave/brave-resources.json` (199 resources after dropping
`brave-*` / `async-sugarcoat-*`). Before the fix it held only 10 entries, so
every `##+js(...)` rule compiled to an empty payload:
`cosmeticFor("https://www.youtube.com/watch?v=…")` returned `script_len=0` and
YouTube's ad JSON was never pruned, which is why video and page ads played.
After the fix the same lookup returns a ~96 KB payload; a live player reports
`ytInitialPlayerResponse.adPlacements`, `.playerAds` and `.adSlots` as
`undefined` with `.ad-showing` false. `tools/blocker-wiring-check.sh` now
fails if `json-prune.js`, `json-prune-fetch-response.js`,
`json-prune-xhr-response.js`, `trusted-replace-xhr-response.js` or their
dependencies are missing from the bundle.

- `cargo check` of the component against vendored adblock 0.12.1: clean.
- `./mach build -j2` (`forge build --jobs 2`): libxul links the crate, IDL and
  XPCOM service. No new vendored crates (adblock/serde/cstr were already in
  the tree).
- `tools/marionette-probe/blocker-probe.py` — **PASS**. On a clean profile:
  - Host reaches `active` with the bundled seed; ≈155k compiled rules.
  - Catalog: 80 lists, 10 default-enabled; `configure` persists 6 h and a
    2-list selection.
  - A loopback page's `/ad.png` is cancelled by the network hook (**server
    sees 0 hits**) while the document loads; `||127.0.0.1^$image` and
    `127.0.0.1##.astra-test-ad` are the proof rules.
  - The page actor hides `.astra-test-ad` (`display:none`) and the native
    cosmetic lookup returns the same selector.
  - Counters advance (2 blocks / 2 decisions / 1 cosmetic page), reset to 0.
  - Settings renders the blocker section, the catalog checkboxes (18 visible
    across the default groups) and the interval selector.
- Contract/unit gates: `node tests/contract/blocker_host.mjs` 97/97,
  `node tests/contract/hostapi_v1.mjs` 327/327, `bun run --filter
  @astra/frame check` (1238 tests), `bun test` in `ui/packages/bridge`,
  `crates/astra-proto/check-drift.sh`, `state-check`, `brand-lint`.

## Scriptlets actually run, and every document gets its own pass (2026-11-22)

Owner report: YouTube played ads after a refresh, and sometimes on the first
visit, while the shield read active and the blocked counters advanced. Three
document-scoped defects in the page half explained both; the network half could
not hide them because YouTube serves ad and content media from the same
`videoplayback` endpoint.

| Symptom | Cause | Fix |
|---|---|---|
| Ads play on sites whose lists stop them with scriptlets; the same page sometimes plays no ad at all | **No scriptlet ever ran.** `blocker/resources/resources.json` (the uBO scriptlet set adblock-rust compiles) ships the scriptlet bodies and helpers, but the harness global they read, `scriptletGlobals`, is created by the injecting layer. Astra never created it, so the first `safeSelf()` call threw `ReferenceError: scriptletGlobals is not defined` inside adblock-rust's own `try { ... } catch {}` wrapper: silently, for every scriptlet on every site. For YouTube that meant the ad JSON was never pruned and whether an ad appeared was YouTube's own decision, which looked random per tab and per visit. | `AstraBlockerProcess.sys.mjs` prepends a harness prelude that defines `scriptletGlobals`. |
| Scriptlets that did evaluate still had no effect on the page (traps on `window`, ad JSON untouched) | The payload ran in a chrome sandbox whose `window` is the page **WindowProxy** and whose intrinsics belong to the sandbox realm. Property traps landed in the Xray expando, invisible to page scripts, and `value instanceof Object` was false for page objects, so a nested chain (`ytInitialPlayerResponse.adPlacements`, the exact YouTube rule) was never trapped. | The prelude binds `window`, `self`, `globalThis` and the standard constructors to the page's own unwrapped inner window (`window.wrappedJSObject`), so traps apply to the objects the page reads and `instanceof` matches. |
| A reload or a fresh tab sometimes missed the scriptlet while another tab worked | Injection was requested from the per-document window actor at `DOMWindowCreated`; in a freshly spawned content process that actor can be created after the event, and the payload lookup itself is asynchronous. | A process actor (`AstraBlockerProcess`) receives the payload the Host computes when the top-level request starts (`http-on-modify-request`) and injects from `document-element-inserted` — before the parser reaches the first script — once per document (WeakSet). The window actor keeps its synchronous fallback (`take()`) and owns CSS, the observer and procedural actions; a document change resets all of that (`#releaseDocument`). |
| A page could show a stale scriptlet/CSS state after a same-window document change | Per-document state (seen classes/ids, sheet URIs, observer, timer, procedural set, `#scriptInjected`, `#url`) survived a document change in one actor instance. | `handleEvent` compares `this.document` with the tracked document; a change runs `#releaseDocument()` (full teardown plus every document-scoped field) before `#start()`. `pageshow` is registered beside `DOMWindowCreated`/`DOMContentLoaded` for bfcache restores and late actors. |

**Live evidence (2026-11-22, packaged Windows dev build):**

- `tools/marionette-probe/blocker-refresh-probe.py` **32/32 PASS**: a local page
  carries a network rule, a cosmetic rule, `##+js(set-constant,
  astraProbeScriptlet, true)` and a nested `##+js(set-constant,
  astraNested.adValue, undefined)`. First load, three reloads, a second and a
  third tab and a switch back all report `display: none`, the page's own inline
  scripts see the scriptlet (so the trap is in the page realm), the nested chain
  is trapped, no page `<style>` node exists (agent-sheet path) and the server
  never sees the ad image. Reloads also assert that the scriptlet precedes the
  first inline script. Before the fix the scriptlet checks failed on every load.
- `tools/marionette-probe/youtube-ads-probe.py` drives a real watch page with
  autoplay enabled. Before the fix an ad played after a reload
  (`.ad-showing` in 10-17 of 30 one-second samples). After the fix the final
  run had **0 ad samples** on the first load and across three reloads, and
  `ytInitialPlayerResponse.adPlacements` was `null` on the navigations where the
  hand-off landed before the page's inline response.
- `tests/contract/blocker_coverage.mjs` **29/29** pins the prelude, the
  page-realm aliases, the process-actor injection, the event set and the
  prefetch hand-off. `blocker_host.mjs` **97/97** and `blocker-probe.py` PASS.

**Limits (honest):** ad media is still not blocked by URL shape; YouTube serves
it from the same host and path as the video, so the scriptlet and cosmetic
layers are doing the work there. The process actor needs the payload computed
at request time; if a navigation commits without that hand-off (rare, observed
once in a three-reload run), the window actor's asynchronous lookup still
installs the scriptlet at `DOMContentLoaded`, which catches later player fetches
but not the document's first inline response. Closing that last case needs a
content-script-style preload hook in the engine, not a JS actor.

## Deferred / limits (honest)

- **CNAME uncloaking is first-party-only and the first request can pass.** The
  Host resolves a first-party subdomain's CNAME chain from Gecko's async
  `nsIDNSRecord.canonicalName` and marks it when the chain ends in a tracker.
  The request that triggered the lookup is already in flight; every later
  request to that host is cancelled. Third-party CNAMEs are not resolved (they
  are not a first-party disguise and would add DNS work to every subresource).
  When the platform returns no canonical name the host stays uncloaked (fail
  open); the Host must **never** ask the engine for a synchronous CNAME record
  here. `DnsQuery_W(RR_CNAME)` blocks for the resolver's full timeout on hosts
  that have no CNAME (11 s on the owner's network), and that callback runs on
  the chrome main thread — it froze the whole window on the first page load
  (fixed in 0.1.753; `blocker_coverage` now rejects the call).
- **Block Scripts uses two native layers.** The channel hook cancels every
  script request; an `http-on-examine-response` observer adds
  `Content-Security-Policy: script-src 'none'` to documents so inline scripts
  are stopped too. It is deliberately strict and site-breaking; the per-site
  shield is the intended path.

- **Redirect resources** (`$redirect=…`) block the request but do not yet
  substitute the redirect body on the network path; scriptlets and CSS are
  live. A redirect needs a response-substitution hook or a `data:` rewrite in
  the channel, which is a separate engine patch.
- **Procedural actions** support the common `:remove()`, `:style()`, `:has-text`
  and JSON action forms. Rare multi-operator filters are ignored rather than
  misapplied.
- **Compilation is synchronous on the main thread.** It happens once per
  install/update; the lists are bounded (48 MiB bundle) and the probe measured
  a clean-profile install without a UI stall. Moving compilation to a worker
  requires dropping Gecko's `single-thread` feature (shared with the content
  classifier), so it is intentionally not done yet.
- **The catalog is the Brave-derived community set.** Brave-owned lists are
  excluded by policy, so a handful of Brave-specific webcompat fixes are not
  present; the generic uBO unbreak/quick-fixes lists cover the same ground.
- **List sources are HTTPS URLs.** A future release can add a signed manifest
  / pinned mirror; the current update validates size, emptiness and a bundle
  byte cap, and never removes the last working engine.

## Real-web smoke (2026-11-07, optional network probe)

`tools/marionette-probe/real-sites-probe.py` loads ad-heavy pages in a
throwaway hard-muted profile (global `media.volume_scale="0.0"`, every tab
`audioMuted`, video `muted` before play). It is not part of the canonical gate
because it depends on the live web, but it is the evidence for "works on real
sites":

| Site | Blocked | Decisions | Trackers with `transferSize=0` | Visible ad slots | Media |
|---|---:|---:|---|---:|---|
| speedtest.net | 9 | 103 | doubleclick, googletagmanager | 0 | — |
| theverge.com | 46 | 247 | doubleclick, amazon-adsystem, googletagservices | 0 | — |
| edition.cnn.com | 28 | 132 | optimizely, adnxs, rubicon, doubleclick, chartbeat | 0 | — |
| forbes.com | 22 | 133 | amazon-adsystem, doubleclick, googletagmanager | 0 | — |
| youtube.com (Rick Astley) | 15 | 243 | none requested | 0 | plays muted, `ad-showing=false`, no ad overlay |

"Trackers with `transferSize=0`" means the resource-timing entry exists but no
body crossed the network — the channel hook cancelled it before connect. A
visible ad slot of 0 means the engine's cosmetic pass hid the containers.

## Strict host coverage: Super Adblock Test (2026-11-10)

The public test at <https://superadblocktest.com/> probes 482 ad, tracker,
analytics, social, consent, affiliate, video-ad, OEM and malvertising targets
with `fetch(url, {mode: "no-cors"})` on `/`, `/favicon.ico` and `/robots.txt`.
A target is "blocked" only when every path fails, and the headline is a
weighted module score; the raw block rate is the plain blocked/total figure.

Community lists cover many of those hosts only for one resource type
(`$script`, `$image`, ...). A `fetch`/XHR beacon, and this probe, therefore
slipped through even while the script was blocked. The bundled Astra list now
carries one host-anchored, type-agnostic `$important` rule for every host in
the reviewed inventory:

| Piece | What it does |
|---|---|
| `blocker/lists/superadblock-hosts.json` | Reviewed inventory: host, categories, scored flag, capture date and source URL |
| `blocker/tools/superadblock.py` | Writes the generated section into `astra-telemetry.txt`; `--check` fails on drift |
| `blocker/lists/astra-telemetry.txt` | `! >>> superadblock-strict` section: one `||host^$important` rule per probed host |
| `tests/contract/blocker_coverage.mjs` | Every scored host has a host-wide rule; generated section current; packaged gzip matches the text; FPP and privacy defaults intact |
| `tools/marionette-probe/superadblock-probe.py` | Live proof: runs the real page three times and requires headline 100 and 0 reachable probes every time |

`vk.com` is the one exception: the probe only tests `/rtrg`, and a host rule
would block the whole network, so the bundled EasyList path rule stays.

**Breakage trade-offs.** The strict section blocks social SDKs
(`connect.facebook.net`, `graph.facebook.com`, `i.instagram.com`,
`widgets.pinterest.com`), consent-management platforms (Cookiebot, OneTrust,
TrustArc, Usercentrics, Osano, Sourcepoint), chat/push/email SDKs (Intercom,
Drift, OneSignal, Mailchimp, Klaviyo) and affiliate redirectors
(VigLink, Skimlinks). Those can remove a site's login-with-Facebook button,
cookie banner, support widget or affiliate link. Astra's per-site shield
(address panel or sidebar shield) pauses blocking for that one site, which is
the intended recovery path. The alternative — leaving them reachable — is the
partial protection the owner rejected.

**Live evidence (2026-11-10, packaged dev build):**

```
PASS blocker active on a fresh profile
PASS filter lists finished installing
PASS compiled rule set is the full bundle :: 198812 rules
PASS run 1 blocks every probe :: 482/482 blocked, 0 reachable
PASS run 1 raw block rate is 100 :: 482/482
PASS run 1 headline is 100 :: 100
PASS run 2 ... 482/482 blocked, 0 reachable, headline 100
PASS run 3 ... 482/482 blocked, 0 reachable, headline 100
superadblock: PASS
```

The probe refreshes the live 14-list bundle before measuring, so the result is
not the offline seed alone. Evidence: `out/superadblock/report.json`.

## Adblock Tester: baits, fetches and a CSP-strict page (2026-11-15)

The second public benchmark, <https://adblocktester.pages.dev/>, runs 443
checks in `full` mode: 437 network targets, four local script baits and two
cosmetic baits. The 2026-11-15 capture (score 93, 410/443) left 33 open. They
had three different causes and needed three different fixes:

| Cause | Fix | Where |
|---|---|---|
| Subdomains the community lists match only for one resource type (`log.tiktokv.com`, `sstats.adobe.com`, `net.rayjump.com`, `pixel.reddit.com`, …) reach a `fetch(no-cors)` | reviewed inventory + the same host-anchored, type-agnostic `$important` shape as the other benchmark | `blocker/lists/adblocktester-hosts.json`, `! >>> adblocktester-strict` section of `blocker/lists/astra-telemetry.txt` |
| `/advertisement.js` and `/analytics.js` baits answered because only `/ads.js` and `/pagead.js` were listed | two more `$script` path heuristics, matching the file name at any depth | `blocker/lists/astra-telemetry.txt` |
| the cosmetic baits (`.adsbox .ad-banner #ad-container`, `.adsbygoogle .google-ad`) were not hidden | the five class/id names are bundled, and the actor applies them as an **agent sheet** through `windowUtils` instead of a page `<style>` node | `blocker/lists/astra-telemetry.txt`, `overlay/astra/actors/AstraBlockerChild.sys.mjs` |

The CSP cause is the interesting one. `adblocktester.pages.dev` ships a
`Content-Security-Policy` whose `style-src` rejects any `<style>` element the
page did not author, so the actor's injected node produced no stylesheet at all
(`style.sheet === null`, computed `display: block`) even though the selector
was present. Cosmetic CSS now loads through
`windowUtils.loadSheetUsingURIString(data:, AGENT_SHEET)`: it is chrome side,
cannot be dropped by the page's policy, and its `!important` declarations
outrank the page's own. The old `<style>` path stays as the fallback when the
seam is unavailable.

Two actor freshness changes came with it:

- **A batch that brings a previously unseen class or id is looked up
  immediately** (bounded to 32 such batches per document), so a container
  injected after load is hidden on the frame it appears instead of after the
  500 ms floor. Batches that only repeat known names still cost nothing.
- **The batch scan reads the mutation records** (added subtrees, their shadow
  roots, class/id attribute changes) instead of re-walking the whole document,
  so the immediate lookup stays cheap on a large page.

### Verification (2026-11-15, packaged Windows dev build)

```
PASS blocker active on a fresh profile
PASS compiled rule set is the full bundle :: 200862 rules
PASS run 1 score is 100
PASS run 1 has no open row
PASS run 1 ran the whole benchmark :: 443/443
... runs 2 and 3 identical
adblocktester: PASS
```

- `tools/marionette-probe/adblocktester-probe.py --runs 3` — three consecutive
  runs, each 443/443 with score 100 and zero open rows. Outside a browser,
  `cargo test -p astra-blocker` (`benchmark_hosts`) compiles the packaged seed
  and proves every inventoried host is blocked for six request types, that both
  new script baits are blocked while `myanalytics.js`/`analytics.min.js` are
  not, and that the five cosmetic names resolve from a bare hint.
- `tests/contract/blocker_coverage.mjs` 22/22 covers both inventories, both
  generated sections, the bait rules and the packaged gzip.
- No regression: `blocker-probe.py` PASS (plus a new check that the page sees
  no style node), `superadblock-probe.py` still 482/482 headline 100.

Trade-offs: `/analytics.js` matches the file name at any depth, so a site that
serves its own analytics bundle under that name loses its statistics (not its
UI); and the cosmetic names are generic enough to hide a legitimately named
element. The per-site shield restores both for one site.
