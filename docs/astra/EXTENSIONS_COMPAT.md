# Chrome and Firefox extension compatibility

> **Status:** implemented and verified on 2026-11-08 against the packaged dev
> build (`engine/obj-astra-linux`, Gecko **153.6.0esr**).
> **Decision:** D-46. **Scope:** the extension platform, not the gallery UI
> copy (that is `EXTENSIONS.md`).
> **Evidence:** `tests/contract/chrome_extensions.mjs` 38 checks,
> `tools/perf/stress/chrome_ext_probe.py` 55/55, real packages 57/57,
> benchmark `out/extension-bench/result.json`.

## What this is

Astra installs and runs extensions through **Gecko's own extension
infrastructure**: `AddonManager`, `WebExtensionPolicy`, the extension process,
content-script injection, permission enforcement and the background event
page. There is no second extension runtime, no script injected into pages to
simulate browser APIs, and no extension code executed in the parent process
beyond what Gecko already does.

The part that is Astra's own is the **Chrome package intake**:

```
Chrome Web Store listing / .crx / .zip / unpacked folder
        │
        ├─ Host API: WebExtensions.prepare / prepareFile / confirm
        │     ChromeExtensions.sys.mjs
        │
        ├─ astra-core sidecar (Rust, `astra-extensions` crate)
        │     CRX3 parse + signature verify
        │     safe ZIP extraction (bounds, traversal, symlinks)
        │     manifest read + Chrome→Gecko adaptation
        │     API inventory + compatibility verdict
        │     behavioural security signals
        │     deterministic XPI writer
        │
        └─ AddonManager installs that exact XPI
              permission prompts / enforcement: Gecko
              background + content scripts: Gecko
              crash isolation + process model: Gecko
```

Firefox add-ons keep the existing path: a signed XPI from
`addons.mozilla.org`, or a local `.xpi`, reviewed and installed by
`AddonManager`. The Chrome path adds verification and adaptation in front of
the same engine.

## Provenance and package verification

| Source | What is verified | What is recorded |
|---|---|---|
| Chrome Web Store CRX | CRX3 magic, protobuf header, RSA PKCS#1 v1.5 SHA-256 proof over `"CRX3 SignedData\0" + len + signed_header_data + ZIP`, publisher id in `SignedData` equals SHA-256 of the signing key, ZIP digest covered by the signature | Chrome id (32 chars, `a`–`p`), package SHA-256, adapted XPI SHA-256, signature result |
| Local `.crx` | the same CRX3 check | the same record, `from_file` |
| Local `.zip` / folder | no store signature; path escapes, symlinks, size and ratio bounds; Chrome id from the manifest `key` or the canonical path (Chrome's own unpacked rule) | `not_present`, package hash |
| Firefox `.xpi` | `AddonManager` signature check (Mozilla root) | the engine's own record |

The Chrome id is the first 16 bytes of SHA-256 over the DER
SubjectPublicKeyInfo, each nibble mapped `0..15 → a..p`. Astra installs under
`<chrome-id>@chrome.astra` (or the manifest's
`browser_specific_settings.gecko.id` when present), so a reinstall/update
replaces the same add-on instead of creating a second one.

**RSA key sizes.** Chrome still serves legacy 1024-bit publisher keys (for
example, Tampermonkey). The verifier accepts 1024–8192-bit RSA with
`RSA_PKCS1_1024_8192_SHA256_FOR_LEGACY_USE_ONLY` from `ring`, verification
only. ECDSA proofs are parsed but not accepted; CRX2 (SHA-1) is refused with an
explicit error. No unsigned file is reported as signed.

**Acquisition.** A Chrome Web Store listing is fetched through Chrome's own
update service
(`clients2.google.com/service/update2/crx?...&x=id%3D<id>%26uc`) only after a
person presses Add. This is an unversioned endpoint Google can change; it is
not presented as a stable API. If it fails, or the returned package does not
verify, the review refuses it and the UI offers “Install from file”. The CRX3
signature is checked before anything is staged. The URL and the failure mode
are recorded in `ENDPOINTS.md` and `KNOWN_LIMITS.md`.

## Manifest adaptation (Gecko 153)

The engine implements most of the Chrome shape. The adapter changes only what
the engine cannot read or run, and the review lists every change.

| Chrome manifest | Astra package | Why |
|---|---|---|
| `background.service_worker` (MV3) | `background.scripts: [worker]`, `persistent: false`, original `type: module` kept | `extensions.backgroundServiceWorker.enabled` is locked `false` in this engine (`Schemas.sys.mjs:308`); event pages are the supported equivalent |
| `importScripts("a.js", "b.js")` | imported scripts listed before the worker, call removed | an event page has no worker global; only static string literals are expanded; dynamic calls are a stated limitation |
| `side_panel` | `sidebar_action.default_panel`, `default_title`, `default_icon` | Gecko has `sidebarAction`, not `sidePanel` |
| `chrome.sidePanel.*` | compatibility prelude maps to `browser.sidebarAction` | same |
| MV3 callback-style `chrome.*` | compatibility prelude wraps promise methods to accept a trailing callback and sets `chrome.runtime.lastError` | MV3 `chrome` is a promise-only alias of `browser` in Gecko (`ExtensionPageChild.sys.mjs:222`); MV2 already has callback compatibility |
| `install` / `activate` listeners | prelude runs them once at background start | service-worker lifecycle events do not exist on an event page |
| `clients`, `skipWaiting`, `waitUntil` | honest no-ops (documented), not fabricated state | service-worker globals |
| MV2 `action` | `browser_action` | MV2 key name |
| `key`, `update_url`, `minimum_chrome_version` | removed | identity is in `browser_specific_settings.gecko.id`; updates are Astra's path |
| Chrome-only permissions (`sidePanel`, `offscreen`, `tabCapture`, `desktopCapture`, `system.*`, `tts`, `fontSettings`, …) | removed and listed | the engine cannot grant them; never silently kept |
| `browser_specific_settings.gecko.id` | added when absent | stable identity for `AddonManager` |
| `/js/background.js` (root-relative) | `js/background.js` | the XPI and extension URLs are relative |
| `content_scripts[].js` | compatibility prelude prepended when needed | callback form and `sidePanel` exist in content scripts too |

The adapted manifest is written to the XPI and the report is stored beside it
(`<ProfD>/astra/extensions/chrome/packages/<id>/<version>/report.json`). The
engine installs exactly that XPI; its SHA-256 is in the install record.

The compatibility prelude (`astra-compat.js`) is generated source, committed
in the crate, reviewed like any other code. It adds no permissions and invents
no results. It is inserted first in background scripts and content-script
groups only when the package needs it.

## API compatibility

The scanner inventories `chrome.*` / `browser.*` calls lexically. It is an
inventory, not a proof that a code path executes.

**Supported by Gecko 153 (schema present):** `action`, `alarms`, `bookmarks`,
`browserAction`, `browserSettings`, `browsingData`, `clipboard`, `commands`,
`contentScripts`, `contextMenus`, `contextualIdentities`, `cookies`,
`declarativeNetRequest` (static, dynamic and session rules), `devtools`, `dns`,
`downloads`, `extension`, `find`, `history`, `i18n`, `identity`
(`launchWebAuthFlow`/`getRedirectURL`; not `getAuthToken`), `idle`,
`management` (with restrictions), `menus`, `notifications`, `omnibox`,
`pageAction`, `permissions`, `privacy`, `proxy`, `runtime`, `scripting`,
`sessions`, `sidebarAction`, `storage` (local/session; `sync` is local-only),
`tabGroups`, `tabs`, `theme`, `topSites`, `userScripts`, `webNavigation`,
`webRequest` (including blocking in MV3), `windows`.

**Partial, with the reason in the review:** `identity.getAuthToken`,
`identity.getAccounts`, `management.install/uninstall/setEnabled`,
`storage.sync` (no account sync service), `action.openPopup` (may need a user
gesture), `tabs.captureVisibleTab` (active tab only), `permissions.request`
(Astra's prompt, engine grant).

**Not implemented by this engine:** `debugger`, `desktopCapture`, `tabCapture`,
`offscreen`, `fileSystem`, `system.*`, `tts`, `fontSettings`, `webstore`,
`gcm`, `instanceID`, `enterprise.*`, `vpnProvider`, `wallpaper`, `loginState`,
`certificateProvider`, `documentScan`, `printerProvider`, `printing`,
`printingMetrics`, `accessibilityFeatures`, `processes`, `power`, plus a few
ChromeOS-only namespaces. The review says which ones the package actually
calls and the verdict becomes **Limited**; a package that only installs is not
called supported.

**Verdicts** (`compatibility.verdict`): `full`, `limited` (some called APIs are
missing), `adapted` (the package shape changed but the called APIs are
present), `unsupported` (cannot run at all), `blocked` (security refusal).
The nine real packages tested below are `adapted` or `limited`, and the review
shows the exact list.

## Security model

Extension code runs where Gecko runs it: the extension process for background
pages, content-script sandboxes for pages. Astra does not relax
`xpinstall.signatures.required`, the content-script sandbox, the extension
process boundary, site-permission prompts, private-window rules or CSP.

The intake adds:

- **Bounds before allocation**: package ≤ 96 MiB, ≤ 20 000 entries,
  uncompressed ≤ 256 MiB, entry ≤ 64 MiB, manifest ≤ 2 MiB, scan ≤ 24 MiB
  (3 MiB per file), compression-ratio refusal. Malformed lengths cannot drive
  an unbounded allocation.
- **Path safety**: absolute paths, `..` segments, backslashes, drive letters,
  NUL and symlinks are refused before extraction. Duplicate entries are
  refused.
- **Transactional install**: inspect → stage to a fresh directory → move into
  the package store → `AddonManager` install → write the record. A failure
  removes the staged/placed directory; no record claims an install that did
  not happen. An update uninstalls the old copy only after the new package is
  staged, and the record is written only after the engine confirms the new
  version.
- **No silent permission changes**: unsupported permissions are removed and
  reported; the engine's permission list is what the person sees and grants.
  Astra never adds a permission.
- **Store signature**: a Chrome Web Store package whose CRX3 signature does
  not verify is refused, not installed with a warning.

### Behavioural signals (not a malware oracle)

Signals are lexical and bounded; every finding carries file, line, a short
excerpt and an explanation. Categories: cryptomining services, remote code,
dynamic code/obfuscation, key events, password fields, cookie access, network
sending, privileged APIs, clipboard reads; the manifest CSP is checked only
for remote **script** sources.

Combination rules use byte proximity (2 KiB) so two unrelated parts of a 1 MB
bundle are not treated as one handler:

| Combination | Level | Action |
|---|---|---|
| known miner alone | medium | review shows evidence |
| miner + remote code/exfiltration, or miner + privileged API | **blocked** | install refused automatically |
| key events + network within 2 KiB | medium | review |
| cookies/password fields + network within 2 KiB | medium | review |
| dynamic code + remote code/data within 2 KiB | medium | review |
| remote script CSP / remote script load | high | review |

A clean report is **not** a safety guarantee and the UI says so. A `blocked`
verdict is reserved for the mining combination, because it has no legitimate
explanation in an extension package.

## Installation, persistence, updates, removal

This build requires Mozilla signatures (`xpinstall.signatures.required =
true`), and an adapted Chrome package is not signed by Mozilla. Astra therefore
installs it through `AddonManager.installTemporaryAddon` and **restores it at
startup** from the verified package store when the extension is not already
registered:

```
<ProfD>/astra/extensions/chrome/
  records.json                    install records (id, version, hashes, verdict)
  packages/<id>/<version>/        package.xpi + report.json
  staging/<review-id>/            only during install
  downloads/<chrome-id>.crx       store acquisition cache
```

`records.json` is written atomically (`tmpPath` + rename). `restore()` runs
once per process after `sessionstore-windows-restored` with a 2.5 s fallback,
skips add-ons the engine already knows, verifies the XPI still exists and
reinstalls it. The record keeps the enabled state, so a disabled extension is
restored disabled. A missing package is shown as a failed row with a retry,
not silently dropped.

On a build with `xpinstall.signatures.required = false`, the same package is
installed persistently through `getInstallForFile().install()`. The review
reports `persistence: "profile"` vs `"session"`; it never pretends a session
add-on is permanent.

Updates use the same review/confirm path. The new version is staged and placed
first, the old temporary add-on is uninstalled, the new one installed, the
record replaced and older version directories pruned. Removal calls
`AddonManager.uninstall`, waits for `onUninstalled`, then removes the record and
the package directory; a failed removal keeps the record so the next start can
retry.

## Isolation, resource use and failure containment

- Background and content execution, process isolation, crash containment and
  permission enforcement are Gecko's. An extension crash does not take the
  browser down; the engine reports it and Astra shows a failed row with Retry.
- The sidecar (Rust) is a separate process. A malformed package makes
  `astra-core` return an error; it cannot take the browser down. The Host API
  never treats a missing core as success.
- Private windows: extension installation is profile-scoped; no private
  browsing data is read or recorded by this path. Per-space extension sets use
  the existing `SpaceExtensions` module and remain enable/disable assignments.
- Bounded state: at most 80 API findings, 40 security findings, 3 truncated
  files listed individually (then one aggregate), 20 findings in a review,
  reviews expire after 10 minutes. No per-navigation growth in this module.
- Package scans are bounded and streamed into the analyzers; the original
  container is read once, the XPI is written deterministically (sorted names,
  fixed timestamps), so an unchanged package has the same hash.

## Verification

| Gate | Command | Result |
|---|---|---|
| Rust unit + integration | `cargo test -p astra-extensions --offline` | 38 + 1 passed |
| Host contract | `node tests/contract/chrome_extensions.mjs` | 38 checks |
| Synthetic live probe | `tools/perf/hidden-display.sh python3 tools/perf/stress/chrome_ext_probe.py out/chrome-ext` | **55/55**, inspect 2.2 ms, install 81 ms |
| Real packages (opt-in network) | `ASTRA_REAL_EXTENSIONS=1 … real_extensions_probe.py` | **57/57**, 5 packages |
| Benchmark (opt-in) | `ASTRA_EXT_BENCH=1 … extension_bench.py` | PASS; see `out/extension-bench/result.json` |

The synthetic probe is a real CRX3 signed by a throwaway RSA key. It proves:
signature and id; adaptation reaches the engine; background runs; the MV3
callback shim reaches storage; `runtime.sendMessage` answers; the content
script runs; disable stops it and enable restarts it; an update reaches the new
version; a restart restores the session package and it runs; uninstall removes
the add-on, record and package; a blocked package, a tampered CRX and a
traversal ZIP never install.

Real packages: uBlock Origin Lite 2026.1103.1743, Dark Reader 4.9.135,
Tampermonkey 5.5.1, Stylus 2.4.17 (Chrome CRX3), uBlock Origin 1.75.4 (signed
AMO XPI). Each was inspected, installed, seen active with a running background
state, its content scripts/rulesets/permissions checked, then uninstalled and
the policy was gone.

Benchmark on this machine (debug dev build, hidden Weston, PSS):
startup 1.85 s, baseline 610 MiB, idle CPU 4.9 %, 60 s growth 24.7 MiB,
3-cycle growth 10.2 MiB, install 0.4–0.6 s, inspect 0.17–0.36 s. These are
measurements, not targets; a release build will differ.

## Regenerating the signed fixture

`crates/astra-extensions/tests/fixtures/probe.crx` and `probe.id` were built
with a throwaway 2048-bit RSA key: a ZIP containing
`manifest.json`, `sw.js`, `lib.js`, `cs.js`, `panel.html`; a CRX3 header with
the RSA proof and `SignedData{crx_id}`; signature over
`"CRX3 SignedData\0" + u32le(len) + signed_header_data + zip`. The regeneration
steps are recorded in the commit that added the fixture. The private key is not
stored: the fixture verifies an identity, it cannot sign new packages.

## Known limits

See `KNOWN_LIMITS.md` for the maintained list. The important ones:

- MV3 service workers run as event pages. Code that depends on true worker
  globals (`clients`, `skipWaiting`, `waitUntil`, service-worker `fetch`
  handling) gets honest no-ops or does not run.
- Dynamic `importScripts` cannot be expanded; it is a stated limitation.
- `ECMAScript` differences between V8 and SpiderMonkey are not translated.
- Chrome's `chrome.*` promise/callback semantics are shimmed for the common
  case; a method that is missing at runtime is still missing.
- The Web Store acquisition endpoint is not an official API and can change.
- No Chrome Web Store signing trust: Astra verifies the CRX3 proof and package
  digest, not Google's store policy or publisher identity beyond that key.
- Chrome-only APIs listed above remain unavailable.
