# Privacy posture: policies + prefs (P1-T06)

Every entry verified against the **pinned source** (ESR 153.6.0), not docs
memory. Policy shapes come from
`browser/components/enterprisepolicies/schemas/policies-schema.json`
(125 policies); implementations from `.../enterprisepolicies/Policies.sys.mjs`.

## `policies.json` (all `IMPL`-verified in `Policies.sys.mjs`)

| Policy | Value | Why / evidence |
|---|---|---|
| `DisableTelemetry` | `true` | Locks `healthreport.uploadEnabled`, `policy.dataSubmissionEnabled`, `toolkit.telemetry.archive.enabled`, `usage.uploadEnabled=false` + blocks `about:telemetry` (impl ~L1289) |
| `DisableFirefoxStudies` | `true` | Disallows Shield + CFR prefs (impl ~L1151) |
| `DisableFirefoxAccounts` | `true` | Kills Sync UI (D-13 accounts later, Phase 7) |
| `DontCheckDefaultBrowser` | `true` | No default-browser nag |
| `OverrideFirstRunPage` | `""` | Empty → no welcome URL + `aboutwelcome.enabled=false` (impl ~L2377) |
| `OverridePostUpdatePage` | `""` | `urlOrEmpty`; no post-update page |
| `Homepage` | `{URL: about:blank, StartPage: none}` | Blank startup |
| `NewTabPage` | `false` | Locks `browser.newtabpage.enabled=false` (impl ~L2343) |
| `FirefoxHome` | Search on, everything sponsored off | No sponsored/pocket/stories/snippets surfaces |
| `NoDefaultBookmarks` | `true` | Clean bookmark bar |
| `DisplayBookmarksToolbar` | `"never"` | Schema enum allows `always/never/newtab` |
| `CaptivePortal` | `false` | No portal checks (endpoint-audit relevant, P1-T07) |
| `NetworkPrediction` | `false` | No speculative connections |
| `DNSOverHTTPS` | `{Enabled: false}` | No default DoH endpoint |
| `DisableSystemAddonUpdate` | `true` | No system-addon downloads |

## `mozilla.cfg` autoconfig (only what policies cannot do)

Plain `defaults/pref/*.js` files **cannot** hold this posture: the app's own
`browser/defaults/preferences/firefox.js` (from
`$SRCDIR/browser/app/profile/firefox.js`, e.g. `app.normandy.enabled=true` at
:2871) loads after them and wins. Autoconfig (`general.config.filename`,
consumed in `modules/libpref/Preferences.cpp`) runs last, and `lockPref`
matches policy-lock strength.

| Pref | Value | Evidence |
|---|---|---|
| `app.normandy.enabled` | `false` | **No Normandy policy exists** (zero hits in `Policies.sys.mjs`); consumer `normandy/lib/RecipeRunner.sys.mjs:43` |
| `app.shield.optoutstudies.enabled` | `false` | Consumers in `normandy/` (ShieldPreferences, BaseStudyAction) |
| `datareporting.healthreport.uploadEnabled` | `false` | `StaticPrefList.yaml` + `all.js`; belt alongside the policy lock |
| `datareporting.policy.dataSubmissionEnabled` | `false` | Same as above |
| `browser.newtabpage.activity-stream.showSponsoredTopSites` | `false` | Branch `ActivityStreamPrefs.sys.mjs:20`; key `TopSitesFeed.sys.mjs:69` |
| `browser.newtabpage.activity-stream.feeds.section.topstories` | `false` | `AboutPreferences.sys.mjs`, `ActivityStream.sys.mjs:740`, `AdsFeed.sys.mjs:43` |
| `browser.newtabpage.activity-stream.discoverystream.enabled` | `false` | `DiscoveryStreamFeed.sys.mjs:70` |
| `...asrouter.userprefs.cfr.addons/features` | `false` | Same keys the `DisableFirefoxStudies` impl sets |

### Protected content (EME)

Astra ships Widevine L3 on by default and owns the only DRM control, so the
engine's own prompt stays out of the way. The CDM update host is a signed-off
`KEEP` (see `tools/endpoint-audit/classify.toml`); the live gate is
`tests/contract/protected_content.mjs`.

| Pref | Value | Why |
|---|---|---|
| `media.eme.enabled` | `true` | Firefox's Linux default is `false`; Astra exposes the choice in Settings → Privacy |
| `media.gmp-widevinecdm.visible` | `true` | The CDM appears and may be downloaded |
| `media.gmp-widevinecdm.enabled` | `true` | The CDM may install/run |
| `browser.eme.ui.enabled` | `false` | No engine-owned "enable DRM" doorhanger or about:preferences checkbox |

L1 and 4K are not available on Linux (see `KNOWN_LIMITS.md`).

### Tracker, fingerprint and referrer hardening (2026-11-10)

| Pref | Value | Why |
|---|---|---|
| `privacy.fingerprintingProtection` (+ `.pbmode`) | `true` | FPP on in normal and private windows |
| `privacy.fingerprintingProtection.overrides` | see `FINGERPRINTING.md` | Canvas/WebGL/audio/WebGPU/WebCodecs/media/display targets; UA, timezone and screen stay real |
| `privacy.trackingprotection.enabled` (+ `.pbmode`) | `true` | ETP's Disconnect list as a second tracker layer |
| `privacy.trackingprotection.cryptomining.enabled` | `true` | Cryptominer list |
| `privacy.trackingprotection.fingerprinting.enabled` | `true` | Disconnect fingerprinting list |
| `privacy.trackingprotection.emailtracking.enabled` (+ `.pbmode`) | `true` | Strips known tracking pixels in webmail |
| `privacy.query_stripping.enabled` (+ `.pbmode`, `.strip_on_share`) | `true` | Removes known tracking parameters before the request and on share |
| `network.http.referer.trimmingPolicy` | `2` | Same-origin Referer drops the path |
| `network.http.referer.XOriginTrimmingPolicy` | `2` | Cross-origin Referer sends only the origin |

These are `defaultPref()` values, so a person's own choice still wins. The
contract gate is `tests/contract/blocker_coverage.mjs`; live gates are
`fingerprint-probe.py`, `shields-probe.py` and `superadblock-probe.py`.

## Deliberate omissions (not oversights)

- **`DisablePocket`**: in the schema but **no implementation** in the pinned
  source — setting it would validate but do nothing. Pocket surfaces die via
  the new-tab prefs above instead.
- **`ExtensionUpdate` / safebrowsing**: left ON (security updates are
  allow-listed in D-15; endpoint audit P1-T07 classifies them).
- **`BlockAboutConfig` / `BlockAboutAddons`**: deferred to hardening; devs
  need them during bring-up.
- **`AppUpdateURL`**: updater is off at build time; URL comes from branding
  prefs in P1-T03.

## Wiring (no new patches)

- Autoconfig: `JS_PREFERENCE_FILES` ships `prefs/local-settings.js`
  (selects `mozilla.cfg`); `FINAL_TARGET_FILES` ships `mozilla.cfg` beside
  the binary. (`JS_PREFERENCE_FILES` = `FINAL_TARGET_FILES.defaults.pref`,
  `python/mozbuild/.../frontend/context.py:3028`.)
- Policies: `FINAL_TARGET_FILES.distribution` → `dist/bin/distribution/`;
  packaged builds include it via `package-manifest.in:466`
  (`@RESPATH@/distribution/*`)

## Test

`tests/contract/p1t06-prefs.py`: fresh profile + geckodriver (built in-tree),
chrome context (needs `-remote-allow-system-access`; ESR 153 removed
`ChromeUtils.import`, use `importESModule`), asserts
`Services.policies.status == ACTIVE(1)`, telemetry pref locked,
`app.normandy.enabled` locked false. Run:
`python3 tests/contract/p1t06-prefs.py`.

## Browser-wide fingerprinting protection (D-43, 2026-11-07)

These are the only new privacy defaults. They are set with `defaultPref()` so a
user value (the Settings switch) wins on every restart; `pref()` would rewrite
the user value each boot.

| Pref | Value | Why |
|---|---|---|
| `privacy.fingerprintingProtection` | `true` | Low-breakage FPP in normal windows |
| `privacy.fingerprintingProtection.pbmode` | `true` | Same in private windows |
| `privacy.fingerprintingProtection.overrides` | `+WebGLRenderInfo,+WebGLVendorSanitize,+WebGLRendererConstant,+AudioContext,+AudioSampleRate,+MediaCapabilities,+NetworkConnection,+FontVisibilityBaseSystem,+CSSResolution,+CSSDeviceSize,+CSSColorInfo,+ReduceTimerPrecision` | Hide GPU/audio/font/display surfaces while leaving UA/timezone/screen intact |

Tracker blocking is the Astra filter-list engine (`BLOCKER.md`), not native
tracking protection. See `FINGERPRINTING.md` for the measured surfaces and the
limits. `media.volume_scale` is a **string** pref (`"0.0"`), used by probes
only, never by the product.
