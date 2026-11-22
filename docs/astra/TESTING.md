# Verification and performance (native merge)

Two runners carry the same gates: `tools/perf/full-suite.sh` on Linux (headed
browser on a private Weston display, never `--headless`) and
`tools/perf/full-suite.ps1` on Windows (packaged `engine/obj-astra-windows`
build, no compositor). The shell runner hands over to the PowerShell one when
it is started from Git-Bash.

```sh
# Linux
tools/perf/full-suite.sh              # build + contracts + UI + live probes + benches
tools/perf/full-suite.sh --skip-build # re-use the current build
tools/perf/full-suite.sh --skip-live  # contracts + UI + lint/state only
tools/perf/full-suite.sh --skip-perf  # skip the benchmark pass

# Windows (PowerShell 5.1 or pwsh; both -SkipLive and --skip-live work)
powershell -ExecutionPolicy Bypass -File tools/perf/full-suite.ps1 --skip-live
pwsh -File tools/perf/full-suite.ps1 -Timeout 600
pwsh -File tools/perf/full-suite.ps1 -Build   # UI bundles + forge build first
```

Both write their logs to `out/full-suite-<UTC stamp>/` (contract-*.log,
probe-*.json, probe-*.err, `summary.txt`, `results.json`); `ASTRA_SUITE_OUT`
picks the directory. A suite that is not registered in the runner fails the
completeness check, so the gate cannot silently shrink.

**What a PASS means.** The registered set passed. It is not a claim that every
script under `tools/` ran: every `tests/contract/*.mjs` is registered (a suite
that exists but is not listed fails the completeness check), and the probe list
holds the ones that were green on the current build. Probes whose expectations
are stale (search engine, `.sidebar-edge`, pre-sidebar bar geometry, the old
240 px column, ffmpeg fixtures) are deliberately unregistered and listed with
their owner in `out/audit/findings/probes.md`; register one again after it is
repaired, never to make the run look complete.

## Layers

| Layer | What it proves |
|---|---|
| `./setup.sh --dry-run` + `tests/contract/setup_model.mjs` | The public one-command install path still parses and plans on Linux/Windows (CI `setup-dry-run`) |
| `tests/contract/*.mjs` | Wire shapes, fences, state machines (Node, no browser) |
| `node --test ui/shell/src` | Shell pure logic (slot state, stage rect, host model) |
| `bun run --filter @astra/frame check` | Svelte/TS types, lint, 1200+ unit/component tests |
| `tests/contract/shell_app_chrome.py` | The packaged chrome window boots, app frame host mode, no legacy paths |
| `tools/perf/stress/*_probe.py` | Real browser behaviour: tabs, spaces, containers, session, permissions, auth, certs, extensions (list, file install, Chrome CRX3 intake, real packages), metadata, page source, media, and a real-web load (`first_load_probe.py`, needs network) |
| `tools/perf/stress/run_matrix.py` | Workload matrix (baseline, tabs, video, 3D, memory, UI tour) with screenshots and CPU/RAM samples |
| `tools/perf/run_all.py` | Startup, memory, scroll/switch and blocker benchmarks |

Every probe resolves its build through `tools/perf/stress/astra_env.py`:
`ASTRA_ENGINE`, `ASTRA_BINARY` and `ASTRA_GECKODRIVER` override, otherwise the
platform's `engine/obj-astra-{linux,windows}` default is used. A probe that
cannot find its binary is reported as SKIP with that reason, not as a product
failure: both runners resolve the path first and skip the probe list when it is
absent, and probes that check it themselves exit 2. Likewise a contract suite
whose fixture is not built (`sidecar_spike` needs `out/sidecar-stub`) is SKIP,
not PASS.

A probe exit code of **2** means "environment cannot run this" (media needs an
audio device, `chrome_ext` needs `python cryptography`, the PiP probes need
`ffmpeg`), not a failure.

## Screenshots

`run_matrix.py --scenario ui-tour --browser astra` writes
`shots/*.png` next to its report. The tour also records per-action latency.


## Extension platform probes

| Command | What it proves |
|---|---|
| `node tests/contract/chrome_extensions.mjs` | Store URL rule, review mapping, blocked refusal, Host method surface (38 checks; no browser) |
| `tools/perf/hidden-display.sh python3 tools/perf/stress/chrome_ext_probe.py out/chrome-ext` | A signed CRX3 installs, adapts, runs background + content scripts + messaging + storage, survives disable/enable and a restart, updates, uninstalls; blocked/tampered/traversal packages are refused (55 checks) |
| `ASTRA_REAL_EXTENSIONS=1 tools/perf/hidden-display.sh python3 tools/perf/stress/real_extensions_probe.py out/real-extensions` | uBlock Origin Lite, Dark Reader, Tampermonkey, Stylus (Chrome) and uBlock Origin (signed AMO XPI) install, run, expose permissions/content scripts/DNR and uninstall (57 checks; network, opt-in) |
| `ASTRA_EXT_BENCH=1 tools/perf/hidden-display.sh python3 tools/perf/stress/extension_bench.py out/extension-bench` | Startup, per-extension inspect/install time, PSS baseline/after/remove, idle CPU, 60 s growth, 3-cycle install/remove growth (opt-in) |

The synthetic and real probes set no `xpinstall.signatures.required=false`:
they exercise the signed build's temporary-add-on + Astra restore path.
| `ASTRA_EXTENSION_CORPUS=1 tools/perf/hidden-display.sh python3 tools/perf/stress/extension_corpus_probe.py out/extension-corpus` | The 55-package corpus installs, runs, exposes its background/content scripts/DNR/permissions and uninstalls (55/55; network, opt-in) |
| `python3 tools/perf/stress/live_store_probe.py` | Opens the packaged build on the real display, opens Chrome Web Store listings, downloads each CRX through Astra, installs it, opens the Extensions page, checks it and removes or keeps it; screenshots in `out/live-store/` (5/5) |
| `python3 tools/perf/stress/extension_corpus_fetch.py out/extension-corpus` | Rebuilds the corpus (68 store ids tried, 55 usable CRX3 packages) |
