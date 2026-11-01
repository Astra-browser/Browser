# Contract tests (P1-T11 harness + siblings)

Browser contract tests boot the **built** binary
(`engine/obj-astra-linux/dist/bin/firefox`, see `docs/astra/BUILD_TIMES.md`)
headless with a fresh profile via the **in-tree geckodriver**
(`engine/obj-astra-linux/dist/host/bin/geckodriver`, `--enable-geckodriver`
in `config/mozconfig.linux`) and drive it over WebDriver/Marionette.
All scripts are **stdlib-only Python 3** — no pip, no Bun, no Go.

| Test | What it proves |
|------|----------------|
| `p1t06-prefs.py` | Policies + autoconfig prefs take effect (P1-T06) |
| `p1t08-shell.py` | Astra shell mounts in the main window (P1-T08) |
| `p1t11-contract.py` | Boots Astra; fixture page loads; `chrome://astra/` loads; Host API version (P1-T11) |

Run any of them directly (`python3 tests/contract/<id>.py`) or via the
forge wrapper: `forge test [--smoke] [--fixture-only]` (see below).

## P1-T11 harness layout

- `tests/fixtures/astra-smoke.html` — static loopback fixture. Marker
  protocol: `#astra-fixture-ok` must contain exactly `ASTRA-FIXTURE-OK`,
  `<title>` must be `Astra Contract Fixture`.
- `tests/contract/p1t11-contract.py` — thin conforming entry point; forwards
  to the runner.
- `tools/contract-runner/run.py` — the real harness: fixture server
  (stdlib `http.server` on 127.0.0.1, ephemeral port), geckodriver lifecycle,
  WebDriver client, checks, artifacts.

## Modes and exit codes

- `run.py` (or `--full`): full contract — 8 checks (fixture title + marker,
  chrome page title + badge, appinfo present, binary branding,
  `HOST_API_VERSION == 1`, handshake echo). Needs the built binary.
- `run.py --smoke`: fast subset — fixture load + chrome page only
  (no Host API import). Still needs the binary.
- `run.py --fixture-only`: no browser at all. Serves `tests/fixtures/` and
  asserts status/title/marker over plain HTTP. Proves the harness works
  where no build exists (CI).

Exit codes: `0` PASS, `1` FAIL, `2` SKIP (browser modes only, when the
binary or geckodriver is absent — run a full build first). Every run writes
`out/contract-p1t11-<UTC>/` (gitignored): `geckodriver.log`, `results.json`,
`console.log`. `forge test` exits non-zero on failure — see artifacts there.

Env overrides: `ASTRA_BINARY`, `ASTRA_GECKODRIVER`, `ASTRA_WD_PORT`.

## Runner choice (Python, not Bun/Go)

The P1-T06/P1-T08 contract tests already prove this exact geckodriver +
Marionette chrome-context pattern against this binary with zero
dependencies. A Bun or Go runner would add a toolchain to CI for no
coverage gain, so the harness stays stdlib Python. Revisit only if a later
phase needs browser automation the stdlib client cannot express.

## Findings recorded by this harness

1. **chrome:// URLs need the provider segment.** Gecko chrome URLs are
   `chrome://PACKAGE/PROVIDER/PATH` with provider `content`|`skin`|`locale`
   (`engine/chrome/nsChromeRegistry.cpp`). The bare form
   `chrome://astra/hello.html` (used as shorthand in older docs) never
   resolves: `convertChromeURL` → `NS_ERROR_FILE_NOT_FOUND`, and WebDriver
   `navigate` to it **hangs geckodriver** (observed 2026-11-01). The harness
   loads **`chrome://astra/content/hello.html`** via `gBrowser.addTab` from
   chrome context with the system principal, then switches to the new
   window handle (Marionette does not follow `selectedTab` set from chrome
   scope). Older `chrome://astra/…` references outside `tools/` + `tests/`
   are left to their owners; the contract asserts the resolvable form.
2. **`resource://astra/` is manifest-registered** (`chrome/astra.manifest`
   line 2) and imports in chrome context (`HOST_API_VERSION == 1`,
   `Boot.handshake` echoes `request_id` with matching `host_api_version`).
3. **Branding:** dev builds use unofficial branding (`BUILD_TIMES.md`), so
   `Services.appinfo.name` reads `Firefox` and the check records a WARN,
   not a failure. The Astra-owned surfaces are asserted hard: the hello
   page title is `Astra — Hello Tab` and the main-window title carries
   `Astra`. Release builds with astra branding must read the
   `branding/astra.toml` display name — that becomes a hard check when the
   release-branding build exists.

## CI

`.github/workflows/ci-fast.yml` runs the no-browser self-test
(`--fixture-only`) on `ubuntu-latest`: it proves the harness + fixture are
sound without a 70-minute engine build. Full `forge test` runs wherever a
real build exists (dev machines; a future build-CI job) and SKIPs loudly
(exit 2) otherwise.
