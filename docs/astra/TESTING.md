# Verification and performance (native merge)

One command runs the whole gate on a private Weston display (headed browser,
never `--headless`):

```sh
tools/perf/full-suite.sh              # build + contracts + UI + live probes + benches
tools/perf/full-suite.sh --skip-build # re-use the current build
tools/perf/full-suite.sh --skip-perf  # skip the benchmark pass
```

## Layers

| Layer | What it proves |
|---|---|
| `tests/contract/*.mjs` | Wire shapes, fences, state machines (Node, no browser) |
| `node --test ui/shell/src` | Shell pure logic (slot state, stage rect, host model) |
| `bun run --filter @astra/frame check` | Svelte/TS types, lint, 1200+ unit/component tests |
| `tests/contract/shell_app_chrome.py` | The packaged chrome window boots, app frame host mode, no legacy paths |
| `tools/perf/stress/*_probe.py` | Real browser behaviour: tabs, spaces, containers, session, permissions, auth, certs, extensions (list, file install, Chrome CRX3 intake, real packages), metadata, page source, media, and a real-web load (`first_load_probe.py`, needs network) |
| `tools/perf/stress/run_matrix.py` | Workload matrix (baseline, tabs, video, 3D, memory, UI tour) with screenshots and CPU/RAM samples |
| `tools/perf/run_all.py` | Startup, memory, scroll/switch and blocker benchmarks |

A probe exit code of **2** means "environment cannot run this" (currently the
media probe: the hidden display has no audio device), not a failure.

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
