# Tab sleeping — policy core (P4-T06)

> Pure policy in `crates/astra-core/src/sleeping.rs`. Effects go through
> Host API `Tabs.discard` / `Tabs.wakeup`
> (`overlay/astra/host/Tabs.sys.mjs`; live binding `discardBrowser` /
> tab reload — see `docs/astra/HOST_API_v1.md`). This crate never touches
> the host modules; tests run against the `StubSleepHost` double.

## Policy

`should_sleep(tab_state, now_ms, config, pressure)`:

1. Exclusions first (never auto-sleep, even under critical pressure):
   - active (selected/visible) tab
   - audible (media playing)
   - pinned (or essential)
   - devtools open
   - already discarded (wake first)
2. Timer last: `idle_ms = now_ms - last_active_ms` (future skew counts as
   recently-active) against the pressure-adjusted timeout:
   - `None` → `idle_timeout_ms` (default 30 min)
   - `Moderate` → half timeout
   - `Critical` → 0 (any inactive, non-excluded tab is eligible)

`select_for_sleep(tabs, now, config, pressure, max_count)` returns the
eligible tabs oldest-first, capped for memory-pressure batch sleeps.

## Wake

`should_wake(discarded, event)`: a discarded tab wakes exactly on
`UserActivated`, `Navigated`, `MediaRequested`, or `ExtensionRequested`.
`BackgroundTick` and `PressureChanged` never wake. Non-discarded tabs
never "wake".

## Round-trip guarantee

Discard snapshots the session row (`TabSnapshot`: URL, scroll, history);
wakeup restores it verbatim. The stub test proves URL + scroll + history
survive discard → wakeup; the P2-T09 session snapshot is the persistence
half of the same guarantee.

## Benchmark hooks

`SleepMetrics`: discarded/restored counters, estimated KiB saved
(default 50 MiB per tab; P4-T10 replaces the estimate with measured
baselines in `PERF.md`), and wake-latency samples
(`mean_wake_latency_micros`, `max_wake_latency_micros`). `SleepBench`
times a discard → wakeup round-trip with `Instant` for the live Host
contract harness; unit tests use the stub's simulated clock.

## Host wiring (read-only)

Production driver calls `Tabs.discard(astra_tab_id)` to sleep and
`Tabs.wakeup(astra_tab_id)` (reload) to restore; `tab.discarded/restored`
events feed `last_active_ms` and the wake path. No host files were
modified by this task.
