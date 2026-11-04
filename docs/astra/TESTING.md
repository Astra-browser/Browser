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
| `tools/perf/stress/*_probe.py` | Real browser behaviour: tabs, spaces, containers, session, permissions, auth, certs, extensions, metadata, page source, media |
| `tools/perf/stress/run_matrix.py` | Workload matrix (baseline, tabs, video, 3D, memory, UI tour) with screenshots and CPU/RAM samples |
| `tools/perf/run_all.py` | Startup, memory, scroll/switch and blocker benchmarks |

A probe exit code of **2** means "environment cannot run this" (currently the
media probe: the hidden display has no audio device), not a failure.

## Screenshots

`run_matrix.py --scenario ui-tour --browser astra` writes
`shots/*.png` next to its report. The tour also records per-action latency.
