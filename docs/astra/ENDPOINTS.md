# Endpoint audit (P1-T07)

Tool: `tools/endpoint-audit/` (Go, stdlib-only) · table: `tools/endpoint-audit/classify.toml`.
CI gate: **no unclassified hosts at idle** — the tool exits 1 otherwise.

## Method

Passive, no root. The tool creates a fresh temp profile (under
`out/endpoint-audit/profiles/`, git-ignored) whose `user.js` routes all
traffic through a stdlib forwarding proxy on 127.0.0.1 with an ephemeral
port (`network.proxy.type=1`, http+ssl). Plain HTTP is forwarded and
logged; HTTPS `CONNECT` targets are logged and the tunnel spliced without
TLS termination (no CA install). `MOZ_LOG=nsHttp,nsSocketTransport,
nsHostResolver` output is collected as a cross-check only — the proxy log
is the source of truth (child-process TLS hostnames do not reliably appear
in the parent necko log, and SIGKILL loses buffered log tail).

Phases: (1) idle soak of `about:blank` (default 10 min, `--idle 30s` for
tests); (2) scripted browsing, one headless process per `--script-urls`
entry (`--per-url-timeout`, default 30 s). Results: JSON + Markdown in
`out/endpoint-audit/captures/`.

Research: Context7 (`/golang/go`: `net/http` handler + `httptest` fixture
patterns) for the tool; Firecrawl enumeration
(`abcdesktop.io/faq/disable-firefox-connections`,
`support.mozilla.org/kb/captive-portal`, `mozilla.github.io/policy-templates`)
cross-checked host-by-host against the pinned ESR 153.6.0 source in
`engine/`. Every table entry cites its evidence; four hosts with zero
source hits (`tracking-protection.cdn.mozilla.net`,
`classify-client.services.mozilla.com`, `search.services.mozilla.com`,
`aus-stage`) are recorded as stale and absent.

## Live run (2026-11-01, built Astra binary)

`engine/obj-astra-linux/dist/bin/firefox`, fresh profile (stock defaults —
no P1-T06 policies, so this is the pre-hardening ceiling), 30 s idle +
one local fixture visit. Idle hosts (10): `push.services.mozilla.com`,
`firefox-settings-attachments.cdn.mozilla.net`, `aus5.mozilla.org`,
`www.google.com`, `update.googleapis.com`, `location.services.mozilla.com`,
`content-signature-2.cdn.mozilla.net`, `ciscobinary.openh264.org`,
`detectportal.firefox.com`, `firefox.settings.services.mozilla.com`.
Scripted visit added only the fixture host (127.0.0.1). After classifying
the 4 newly observed hosts, the gate re-run is PASS.

## Classification

| Host | Class | Kill switch (verified name) |
|---|---|---|
| `detectportal.firefox.com` (+`example.org`, `cloudflare-dns.com` connectivity checks) | REMOVE | P1-T06: `CaptivePortal=false`; `network.captive-portal-service.enabled=false`, `network.connectivity-service.enabled=false` (`all.js:3257-3282`) |
| `incoming.telemetry.mozilla.org` | REMOVE | P1-T06: `DisableTelemetry=true`; `toolkit.telemetry.server` |
| `normandy.cdn.mozilla.net` | REMOVE | `mozilla.cfg`: `app.normandy.enabled=false`, `app.normandy.api_url=''` (`NormandyApi.sys.mjs:16`) |
| `location.services.mozilla.com` | REMOVE | `browser.region.network.url=''` (`all.js`) |
| `contile.services.mozilla.com` | REMOVE | `browser.topsites.contile.enabled=false`, `...endpoint=''` (`firefox.js`) |
| `spocs.getpocket.com` | REMOVE | `...discoverystream.enabled=false` (P1-T06) |
| `push.services.mozilla.com` | REMOVE | `dom.push.connection.enabled=false` (`all.js`: `dom.push.serverURL`) |
| `*.firefox.com` (accounts, sync) | REMOVE | P1-T06: `DisableFirefoxAccounts=true` |
| `phish-error.mozilla.com` | REMOVE | `...reportPhishMistakeURL` blank if needed (`all.js:3392`) |
| `shavar.services.mozilla.com`, `safebrowsing.google.com` | KEEP | Security-critical SafeBrowsing (D-15 allow-list) |
| `versioncheck.addons.mozilla.org` | KEEP | Extension updates until Phase 4 gallery (`extensions.update.url`) |
| `addons.mozilla.org` | KEEP | Signed Firefox package download / listing, only when a person installs or opens the gallery |
| `chromewebstore.google.com`, `chrome.google.com` | KEEP | Chrome Web Store listing pages and the Add action; no background traffic |
| `clients2.google.com` | KEEP | User-initiated Chrome package acquisition (CRX3 verified before staging); unversioned endpoint, file import is the fallback |
| `aus5.mozilla.org` | REPLACE | `MOZ_APPUPDATE_HOST=<astra-host>` at build time (`build/moz.build:95-97`); covers GMP (`all.js:3474`) |
| `firefox.settings.services.mozilla.com` + `content-signature-2.cdn.mozilla.net` + `firefox-settings-attachments.cdn.mozilla.net` | REPLACE | `services.settings.server=<astra-mirror>` — owner decision pending |
| `ciscobinary.openh264.org` | REPLACE | `media.gmp-manager.url` repoint or disable — owner decision (`gmp-sources/openh264.json`) |
| `update.googleapis.com` | REPLACE | Widevine update (`firefox.js:2373`); ship-or-drop is an owner decision |
| `*.google.com` (`www.google.com` observed once at idle) | REPLACE | Ship Astra search config; exact trigger to pin in follow-up |

All `owner_signoff=false`: seeded by worker-t07, pending owner review
(§1.5: STOP-and-ask items go to `OWNER_QUESTIONS.md` via orchestrator).

## CI

Gate job runs the tool with `--idle 30s` against the built binary (or
documents fallback to stock Firefox when the build is absent) and fails
the build on exit 1. Full 10-minute soak runs nightly/on-demand; any new
host fails until classified in `classify.toml` with evidence.
