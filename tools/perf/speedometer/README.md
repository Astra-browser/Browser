# Speedometer 3.0 / 3.1 harness

`run_speedometer.py` drives the packaged Astra dev build through the WebKit
Speedometer benchmark and records a reproducible score.

## Why it runs on the real display

Speedometer 3 uses `requestAnimationFrame` to trigger its async measurement.
The private Weston display used by the other probes has no vsync source, so
rAF fires at roughly 1 Hz there and the benchmark crawls or times out. This
harness therefore runs headed on the owner's display, floats/resizes the
window to 1600x1000 through Hyprland, and restores nothing else. Set
`ASTRA_SPEEDOMETER_MONITOR` to park the window on another output and
`ASTRA_SPEEDOMETER_KEEP_FOCUS` to return focus to a monitor; otherwise it
brings the test window to the front for the run.

## Usage

```sh
# Speedometer 3.1 (local copy from the engine tree; offline and deterministic)
python3 tools/perf/speedometer/run_speedometer.py \
    --version 3.1 --iterations 10 --runs 3 --label baseline

# Speedometer 3.0 (hosted page; the engine tree has no 3.0 copy)
python3 tools/perf/speedometer/run_speedometer.py \
    --version 3.0 --iterations 5 --runs 2 --label baseline

# A/B a preference without rebuilding
python3 tools/perf/speedometer/run_speedometer.py \
    --version 3.1 --iterations 10 --runs 1 \
    --pref javascript.options.ion.threshold=800
```

Results go to `out/speedometer/<label>-<version>.json` plus one screenshot per
run. The process exits 0 only when every run produced a numeric score; an
`Error` result (the benchmark's own invalid-score path) is a failure, and a
result that arrives in under 5 s for a multi-iteration run is treated as a
stale page.

## What the score means

Speedometer 3 is not a percentage and has no upper bound or "infinity" value.
It is calibrated against a reference machine: a fast desktop browser scores in
the tens. Treat the number as a relative measure on the same machine and build,
not as a grade. The current dev-build baseline and the PGO/LTO gap are recorded
in `docs/astra/PERF.md` §7.

## Notes

- The harness needs `hyprctl` for geometry; without it (or with
  `--no-geometry`) a tiling compositor may give a viewport below the 850x650
  minimum and the score becomes incomparable.
- `--pref KEY=VALUE` writes a `user_pref` into the throwaway profile; JSON
  values (`false`, `800`) are parsed, everything else is a string.
- The profile is removed on exit; a killed harness cannot clean it up, so
  check `/tmp/astra-speedometer-*` after an interrupted run.
