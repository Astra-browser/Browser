# Astra stress matrix

Loopback-only stress harness for the Astra dev build and stock Firefox. It
answers "which part of the browser uses which resource" with simultaneous
CPU / RAM / GPU samples, not separate tools.

## What it captures

Every 0.5 s, for the browser process tree only:

- CPU per process (`/proc/<pid>/stat`) and the whole machine (`/proc/stat`)
- PSS / private / swap memory per process (`smaps_rollup`)
- DRM GPU engine time per process (`fdinfo`: render / video / copy) and GPU
  memory per DRM client
- iGPU busy from the i915 rc6 counter, dGPU from `nvidia-smi`
- CPU frequency, package temperature, load, swap IO, major faults
- thread and fd counts per process

Pages post a heartbeat every 2 s: rAF rate, visibility API, video playback
quality (`decoded`/`dropped` frames), and the WebGL renderer. A fixed
`?w=&h=&sync=1` 3D fixture with `gl.finish()` measures completed GPU work
instead of vsync callbacks.

## Run

```sh
# one scenario, one browser
python3 tools/perf/stress/run_matrix.py --browser astra --scenario 3d-1

# full matrix (Astra + stock Firefox, 10 scenarios)
python3 tools/perf/stress/run_matrix.py --browser both --scenario all --repeat 1
python3 tools/perf/stress/summarize.py --dir out/stress-<stamp>
```

Each run writes `out/stress-<stamp>/<browser>-<scenario>-rN/`:

| File | Contents |
|---|---|
| `samples.jsonl` | one full process table per sample |
| `summary.json` | per-phase mean/p50/p95/max + per-kind roll-ups |
| `reports.jsonl` | raw page heartbeats |
| `REPORT.md` | automatic per-run report |
| `meta.json` | timings, checks, tab map, animations, UI lag |
| `shots/` | chrome screenshots |

The same per-run block is appended to `docs/performance/OBSERVATIONS.md`;
`summarize.py` writes the consolidated `docs/performance/STRESS_REPORT.md` and
inserts a key-observations block into `docs/performance/OBSERVATIONS.md`.

## Scenarios

| Name | What runs |
|---|---|
| `baseline-1tab` | one local blank page |
| `baseline-newtab` | New Tab only, no content page |
| `tabs-8static` | eight static pages on four origins |
| `video-2` / `video-6` | 2 / 6 muted 1080p30 tabs (H.264 + VP9) |
| `3d-1` | one WebGL2 raymarch scene, fixed 1280×720, `gl.finish()` |
| `3d-4` | four such tabs, one visible |
| `mixed-8` | 2 video + 2 WebGL + 2 JS + 2 static |
| `memory-6` | six tabs each holding 64 MiB resident + 12k DOM nodes |
| `ui-tour` | six tabs then real UI clicks (tab create/switch, address bar, sidebar, Work, Settings) |

## Real-site tab stress (cold cache)

`web_tabs_probe.py` opens a fixed list of real sites (news, video, heavy web
apps), one URL per site, in a fresh profile, so nothing is served from cache.
It walks every tab afterwards: Astra's background tabs are lazy
(`Content.sys.mjs` `pending`), so creating 50 tabs loads nothing and activation
is what a person actually pays. Video tabs are muted through `Tabs.setMuted`.

```sh
python3 tools/perf/stress/web_tabs_probe.py                       # all 50, ~4 min
python3 tools/perf/stress/web_tabs_probe.py --tabs 20 --steady 30
```

It writes `out/web-tabs-<stamp>/`: `samples.jsonl` (2.5 s rows), `result.json`
(phases, activation times, per-tab PIDs, mute flags, video playback quality),
`REPORT.md` (phase table), `tabs.png`, and the sampler it used
(`sampler.ps1` on Windows). The Windows sampler covers CPU per process,
private/working set, GPU engine + video decode, GPU memory, handles, threads,
network and commit charge; on Linux the tree is walked through `/proc`
(CPU, RSS, private) and GPU columns stay null — `run_matrix.py` owns GPU
attribution there.

## Notes / traps
- The harness launches headed builds with a fresh profile and normalises the
  window with Hyprland Lua dispatchers (`hyprctl eval`), because tiling gives
  each browser a different viewport.
- `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` is required for stock Firefox 159 chrome
  context; ESR 153 also accepts the CLI flag.
- Do not put an unconditional `requestAnimationFrame` loop in a "static"
  fixture: it turns the idle baseline into a 60/144 fps redraw test. Only
  `video`, `css`, `3d`, `js` (or `?hb=1`) run the rAF counter.
- Astra's content stage measures ~56–60 rAF/s on this 144 Hz panel while stock
  reaches ~135–149. Animated workloads are compared per frame as well as in
  absolute terms; see `docs/performance/STRESS_REPORT.md`.
- A pre-existing Firefox/profile on the machine is never counted: the sampler
  only walks descendants of the PID it launched.
