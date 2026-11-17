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
   - `None` → `idle_timeout_ms` (default 5 min)
   - `Moderate` → half timeout
   - `Critical` → 0 (any inactive, non-excluded tab is eligible)

`select_for_sleep(tabs, now, config, pressure, max_count)` returns the
eligible tabs oldest-first, capped at `max_count` every tick so one pass never
discards everything. Before the idle/pressure test it drops the
`keep_warm_count` most recently active eligible tabs (ties by id ascending),
clamped to one fewer than the set so the oldest tab always remains a
candidate.

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

## Host driver (2026-11-05)

`overlay/astra/host/Performance.sys.mjs` is the live consumer of the settings.
Firefox's own `TabUnloader` only acts under memory pressure and reads its pref
at module load, so before this the Settings choice never changed the
behaviour.

| Setting | Read on every tick | Effect |
|---|---|---|
| `performance.sleep` | `browser.tabs.unloadOnLowMemory` | master switch; `false` tears the interval down |
| `performance.after` | `browser.tabs.min_inactive_duration_before_unload` | idle delay: 5/15/30/60 minutes |
| `performance.memory` | Astra key | `balanced` (full delay), `save-memory` (half delay), `keep-ready` (background unload off); every mode batches 4 per tick |
| `performance.exceptions` | Astra key | sites (and their subdomains) that never sleep |

The policy is a line-for-line JS twin of `sleeping.rs`
(`should_sleep`, `effective_timeout_ms`, `select_for_sleep`); a contract test
walks both implementations' cases. A tick enriches the model's
`__sleepState()` with native facts (audible, DevTools, `beforeunload`, pinned)
and discards oldest-first through `Tabs.discard`; the content binding then
calls `gBrowser.discardBrowser`. If the engine refuses, the model is put back
to awake, so the projection never claims a sleeping page. A change to
`performance.after` runs a tick immediately; the driver reads the settings
rather than caching them.

Teardown: one interval, one event subscription and one `unload` listener.
`stop()` (and the test reset) releases all three; the sleeping tab row is
`TabView.availability = { state: "sleeping" }`, and selecting it clears the
flag (the tabbrowser restores the page).

## Unknowns the core still owns

Nothing in `astra-core` consumes these settings yet. The policy crate remains
the reference and the host is the live owner until the core exposes a
`tabs.sleep`/`tabs.wake` command pair. Time/focus persistence is host-side for
the same reason; see `STATE.md` for the exact missing commands.

## Live probe

The shell publishes its Host API on `Services.astraHost`, so a Marionette
`context.chrome` script can drive the real driver without a debug build hook:

1. Open ten tabs (loopback fixtures or an intranet host), select the first.
2. Set `performance.after` to `5` and add one tab's host to
   `performance.exceptions` through Settings.
3. Call `Services.astraHost.Performance.tick(Date.now() + 6 * 60_000)`.
   The future instant is the probe's clock, not a fake result: the same
   `selectForSleep`/`discardBrowser` path runs and the tabs really die.
4. Assert `Services.astraHost.Performance.status().slept` names the idle tabs,
   each native tab has the `discarded` attribute, the exception tab does not,
   and the projection marks the sleeping rows with
   `availability.state === "sleeping"`.
5. Select a sleeping tab; assert its native `discarded` attribute clears and
   its projection row no longer carries `availability`.
6. Optional memory proof: `about:memory` (or the P4-T10 harness) before/after
   the tick. Teardown: reload the window or call `Performance.stop()`; the
   interval and both listeners are gone.


