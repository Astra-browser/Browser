# Astra performance plan — lighter and faster than Firefox

> Status: proposal (2026-11-04). Baseline data: `STRESS_REPORT.md`,
> `observations.md`, `docs/astra/PERF.md` §7. Engine: ESR 153.6.0. Comparison:
> installed Firefox 159.0 on the same box.

## 1. The thesis

Astra is **not** losing on engine throughput. With a focused window the 3D
fixture runs at **143.6 rAF/s** vs Firefox **139.4**, video decode is on the
RDD/iGPU with 0–3 dropped frames, and settled idle is 0.00 cores on both.
The gaps are lifecycle and chrome cost:

1. A fast page is held behind the loading skeleton for **15 s** because
   `Content.watch()` waits for a poll to see `isLoadingDocument = true`.
2. Parked content docshells stay active: background pages report `visible`,
   background video/JS keeps working, and four 3D tabs hold **+153 MiB PSS
   and +232 MiB GPU memory**.
3. Astra carries **+73–81 MiB** of base memory (7 content processes for one
   tab vs stock 4; a larger chrome/app heap).
4. 3D uses **31.6% more GPU per frame** than stock at the same scene and
   resolution — consistent with the app layer still compositing under the
   content stage.
5. Startup to UI ready is **1.88–2.14 s** vs stock **1.41–1.51 s**.

The route to “lighter than Firefox and faster than Firefox” is therefore:
**make the page appear at commit, freeze/harden background tabs like a
first-class lifecycle, shrink the base process/app footprint, and remove the
extra compositor pass.** The engine itself already gives us the headroom.

## 2. Targets

Every target is measured with the existing harness, same fixtures, same
144 Hz panel, 3 runs, median. “vs FF” is the comparison with stock Firefox.

| Budget | Astra now | Firefox now | Target | vs FF |
|---|---:|---:|---:|---:|
| 1 tab settled PSS | 509 MiB | 436 MiB | **≤ 410 MiB** | −6% |
| 8 static tabs settled PSS | 563 MiB | 500 MiB | **≤ 475 MiB** | −5% |
| 6 video tabs settled PSS | 761 MiB | 688 MiB | **≤ 650 MiB** | −5% |
| 4 3D tabs settled PSS | 631 MiB | 478 MiB | **≤ 450 MiB** | −6% |
| 4 3D tabs GPU memory | 462 MiB | 231 MiB | **≤ 215 MiB** | −7% |
| Local first paint after commit | ~15 s skeleton | instant | **< 300 ms** | parity |
| 1-tab first-10s CPU | 0.44 cores | 0.03 cores | **≤ 0.05 cores** | parity |
| 8-tab first-10s CPU | 0.53 cores | 0.02 cores | **≤ 0.05 cores** | parity |
| Mixed-8 settled CPU | 5.81 cores | 4.23 cores | **≤ 4.2 cores** | parity |
| 6-video GPU video engine | 15.2% | 3.8% | **≤ 5%** | parity |
| 3D 720p rAF/s | 143.6 | 139.4 | **≥ 150** | +8% |
| 3D GPU % per frame | 0.406 | 0.309 | **≤ 0.31** | parity |
| Cold start spawn→UI | 1.88–2.14 s | 1.41–1.51 s | **≤ 1.35 s** | −5% |
| Tab switch median | 17.8 ms | native | **≤ 15 ms** | — |
| Visibility mismatches | 7 / 5 / 3 | 0 | **0** | parity |
| 50 tabs settled PSS | not measured | measure first | **≤ FF** | ≤0% |

These are stretch targets, not commitments. The first three alone remove the
perceived slowness and the biggest power burn; the memory targets require the
lifecycle and process work.

## 3. Workstreams

### A. Make the page appear at commit (P0)

**Problem:** `Content.watch()` uses a 200 ms poll and a 15 s `startDeadline`.
A fast load finishes before the first poll, so `seenLoading` stays false, the
model keeps `loading: true`, and the shell keeps `[data-loading=true]`:
the browser is `opacity: 0`, the skeleton shimmer/spinner and favicon orbit
run, and the user sees a fake 15 s load.

**Fix:**
- First-poll fast path: if the browser is already on the requested URL and
  `isLoadingDocument` is false, treat it as loaded and clear immediately.
- Prefer a commit/load/pageshow signal over polling; the 15 s deadline stays
  only for “request never started”.
- On commit, stop hiding the content browser; the skeleton is a pre-commit
  surface only. Never show a skeleton over a document that is already there.
- Cancel/pause `sk-shimmer`, `loading-spinner`, `favicon-orbit` when the stage
  is hidden or the page is committed.
- Contract test: local fixture `loading` false and content visible `< 500 ms`.

**Expected:** first paint 15 s → <300 ms; 1-page transient CPU 0.44 → ~0.03
cores; GPU 12% → 0%; 8-tab transient 0.53 → ~0.05.

### B. First-class tab lifecycle (P0/P1)

**Problem:** every `<browser>` stays `docShellIsActive = true`; parking only
toggles Astra attributes. Pages never receive `visibilitychange`, hidden
video/JS keeps running, and 3D contexts stay resident.

**Fix:** a per-tab state machine equivalent to the Page Lifecycle model
(active → passive → hidden → frozen → discarded), implemented in Gecko terms:

- **Active:** `docShellIsActive = true`, visible, focused.
- **Passive:** visible, unfocused; still render.
- **Hidden:** `docShellIsActive = false`, `preserveLayers = false`, dispatch a
  real visibility state; stop rAF, timers, canvas/WebGL work; keep audio only
  where policy allows.
- **Frozen:** after N seconds hidden, suspend media decode, release WebGL
  contexts (`WEBGL_lose_context`), close IDB/WebSocket/WebRTC work where the
  page cooperates, persist scroll/form state.
- **Discarded:** after a longer idle or memory pressure, unload the document
  with `gBrowser.discardBrowser(tab)` / the `tabs.discard()` path, keep the
  tab row and a sleeping state, restore via SessionStore on selection.

**Policy inputs:** pinned tabs, forms with unsaved input, active uploads,
WebRTC/audio, “important sites”, battery/thermal state, per-space budget.
Default to conservative; expose the timeout in Settings (`performance.sleep`,
already present).

**Expected:** mixed-8 5.81 → ≤4.2 cores; 4 3D PSS −150 MiB and GPU memory
−230 MiB; video engine 15.2% → ~4%; visibility mismatches 0. This is the
single biggest “lighter than Firefox” lever because Firefox only unloads on
low memory with a 10-minute default minimum.

### C. Process and app-memory diet (P1)

**Problem:** Astra starts 7 content processes for one tab (stock: 4), and the
chrome/app base is ~+75 MiB. Content PSS is ~106 vs ~58 MiB.

**Fix:**
- Audit the 7 processes with `about:processes` and the tab map: loaded,
  preallocated (default 3), privileged, extension, container/space.
- Reduce `dom.ipc.processPrelaunch.fission.number` from 3 to 1–2, adaptive to
  RAM and startup state; measure first-navigation latency before/after.
- Keep isolation: do not share a content process across spaces/containers.
  Pool only same-site/same-space tabs where Fission already allows it.
- Do not create a warm `<browser>` for every tab; create on first selection,
  keep one warm process.
- App heap: `about:memory` + DMD on the parent; find the 77 MiB New Tab cost.
  Audit eager imports, icon packages, Svelte stores and retained DOM.
  Lazy-load Work, Settings, Notes, AI, ELK/diagram worker, settings sections.
- `content-visibility: auto` for off-screen panels; virtualize History,
  Bookmarks, tab lists; release closed-tab DOM and screenshots.
- Cap caches (favicons, images, session snapshots); expose a memory budget per
  space.

**Expected:** 1 tab 509 → ≤410 MiB; 8 tabs 563 → ≤475; 3D 631 → ≤450; app
startup −0.2–0.4 s from less JS.

### D. Compositor and GPU (P1/P2)

**Problem:** Astra’s 3D uses 58.4% GPU vs stock 43.0% at essentially the same
frame rate. The likely cause is the full-window app iframe still painting
under the content stage; the content is an overlay at `z-index: 2`, so the app
layer is composited underneath it.

**Fix / experiments:**
- A/B: hide `.astra-app-frame` while a page is in front, or clip the app layer
  to the sidebar/header only. Measure 3D GPU/frame and video engine.
- If confirmed, restructure the stage so the app layer does not cover the
  content rect: separate sidebar/header surfaces, no transparent full-window
  iframe under the page, `preserveLayers = false` on parked tabs.
- Remove unnecessary `will-change`, `clip-path`, transparent backgrounds and
  `mix-blend-mode` from the content path.
- Video: use the engine’s background suspend policy
  (`media.suspend-bkgnd-video.enabled`, delay) for hidden tabs; keep audio.
- WebGL: ensure hidden tabs stop rAF, release the context on freeze, never
  call `gl.finish()` in production; audit whether WebGL is remoted to the
  parent/GPU process and whether that costs an extra copy.
- Keep `powerPreference: high-performance` only when the site asks for it.

**Expected:** 3D GPU per frame 0.406 → ≤0.31; video engine 15.2 → ≤5%;
fewer GPU wakes on idle.

### E. Startup (P1)

**Problem:** +0.4–0.6 s to UI ready; spawn→Marionette is the same, so it is
shell/app boot, not process launch.

**Fix:**
- Instrument phases: spawn → Marionette → app document → settings/theme →
  projection → first paint.
- Paint a lightweight static shell immediately; hydrate the Svelte app behind
  it. Keep the current first-paint quality gate, but make the gate cheaper.
- Code-split everything not needed for the first frame (Work, Notes, Settings,
  AI, ELK, onboarding, large icon sets).
- Reduce JSON/IPC bootstrap work: one settings batch, one projection, no
  redundant `tabs_bootstrap`.
- Cache chrome assets; avoid duplicate parsing; measure jar/resource load.
- Re-evaluate preallocation: fewer processes can improve both startup and
  memory, but may add first-navigation latency; measure the trade.

**Expected:** ≤1.35 s UI ready; 1-tab memory target includes the app.

### F. Guardrails and measurement (continuous)

- Keep `tools/perf/stress/`: add 50 tabs, 30-min idle + sleep, discard/restore,
  form/scroll restore, audio/video background, and “warm vs cold” startup.
- Gate PRs on budgets: memory ±5%, CPU/GPU ±10%, startup ±50 ms, first paint
  <500 ms; 3 repeats, median/p95; compare against stock 159 and ESR 153.
- Use `about:memory` diffs (resident/explicit/heap-unclassified) and DMD for
  parent/content leaks; Gecko Profiler for CPU attribution; `about:processes`
  for process count.
- Publish a nightly trend, not just a one-off report.

## 4. Sequence and expected wins

| Phase | Work | What moves |
|---|---|---|
| 0 (1–2 days) | A: loading fast path + skeleton rules + tests | perceived load 15 s → <300 ms; transient CPU/GPU gone |
| 1 (week 1) | B: docshell/visibility/freeze; background media; WebGL release | mixed CPU −1.5 cores; 3D PSS −150 MiB / GPU −230 MiB; video engine −10 pp |
| 2 (week 2) | C: process audit, prealloc 3→1–2, app heap/lazy bundles | base −60–90 MiB; 1/8-tab targets |
| 3 (week 3) | D: compositor A/B, app layer under content, video policy | 3D GPU/frame −20–25%; video engine parity |
| 4 (week 4) | E + F: startup, 50-tab sleep/discard, CI gates | ≤1.35 s; ≤FF at 50 tabs; regression guardrails |

The order matters: A is independent and immediately user-visible; B unlocks
most of the memory/GPU savings; C and D then get us below stock; E is the
last perceived-latency win.

## 5. What not to do

- Don’t reduce process isolation or share processes across spaces/containers
  just to win a memory number. Security boundaries stay.
- Don’t discard tabs without SessionStore, scroll/form state and exceptions
  for audio, uploads, WebRTC, pinned tabs and important sites.
- Don’t ship aggressive `dom.ipc.processCount=1`-style prefs as defaults;
  make them adaptive and measure first-navigation latency.
- Don’t use `gl.finish()` or benchmark-only settings in production.
- Don’t compare ESR 153 with Firefox 159 and call every delta an Astra bug;
  get a stock ESR 153 binary for the final budget run.
- Don’t “fix” the 15 s load with a smaller timeout alone; the state must be
  driven by the real commit/load, not a guessed delay.

## 6. Research notes

- Mozilla, *Process Model*: 3 preallocated content processes by default,
  8 shared web-content processes, ~25–30 MB per full content process; GPU
  process optional on Linux (compositing may run in the parent).
  https://firefox-source-docs.mozilla.org/dom/ipc/process_model.html
- Mozilla, *Process Isolation in Firefox*: ~7–10 MB minimal XPCOM process,
  25–30 MB full content process.
  https://mozilla.github.io/firefox-browser-architecture/text/0012-process-isolation-in-firefox.html
- Mozilla Support, *Unload inactive tabs to save system memory*:
  `browser.tabs.unloadOnLowMemory`; tab unloading is a low-memory safety
  valve, not a proactive policy.
  https://support.mozilla.org/en-US/kb/unload-inactive-tabs-save-system-memory-firefox
- ArchWiki, *Firefox/Tweaks*: `browser.tabs.unloadOnLowMemory`,
  `browser.tabs.min_inactive_duration_before_unload` (default 600000 ms),
  `dom.ipc.processCount`.
  https://wiki.archlinux.org/title/Firefox/Tweaks
- MDN, `tabs.discard()`: the supported unload/reload primitive.
  https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/discard
- Chrome, *Page Lifecycle API*: active/passive/hidden/frozen/discarded;
  `freeze`/`resume`, `document.wasDiscarded`; hidden is the last reliable
  state; close IDB/WebSocket/WebRTC and persist state before freezing.
  https://developer.chrome.com/docs/web-platform/page-lifecycle-api
  (Use this as a design model; Gecko does not expose all of these DOM events.)
- Mozilla, *about:memory*: resident/explicit/JS/layout/gfx breakdowns, DMD,
  diffing two reports.
  https://firefox-source-docs.mozilla.org/performance/memory/about_colon_memory.html
- Mozilla, *Improving Firefox startup time with the about:home startup cache*
  (startup cache concept; adapt to the Astra shell).
  https://blog.mozilla.org/performance/2020/07/16/improving-firefox-startup-time-with-the-abouthome-startup-cache/

## 7. First commits

1. `fix(content): clear loading on the first poll when the document is ready`
2. `fix(shell): show the page on commit; skeleton only before commit`
3. `fix(shell): pause skeleton/favicon animations when the stage is hidden`
4. `feat(content): deactivate parked docshells and emit real visibility`
5. `feat(content): suspend background media and release WebGL on freeze`
6. `perf(ui): lazy-load Work/Settings/Notes/ELK and virtualize long lists`
7. `perf(compositor): stop painting the app layer under the content rect`
8. `test(perf): local load visible <500 ms; background tab CPU/memory bounds`

## 8. What has landed / what changed after the tree audit (2026-11-04)

**Landed on main**
- `b87ba7c` — fast load state. A loopback page that finishes before the first
  200 ms poll clears `loading` immediately instead of waiting out the 15 s
  `startDeadline`. Live probe: **206–230 ms** (was 15 s); slow-start probe still
  holds the skeleton until the first byte, then clears.
- `a388bb4` — parked tab lifecycle. `manualactiveness="true"`, active tabs
  `docShellIsActive=true` + `preserveLayers(false)`, parked tabs
  `preserveLayers(false)` then `docShellIsActive=false`. Live three-tab probe:
  active visible/rendering, parked hidden/inactive/non-rendering, pages stay
  loaded with the same `timeOrigin`, switch-back does not reload, and
  background **audio keeps advancing** while parked.
- `6dddb53` — settings rail is no longer in the browser startup graph.
  Startup graph **506,805 → 452,823 bytes (−10.7%)** and **85 → 74 chunks**;
  browse first paint and first-frame completeness unchanged.

**Post-fix re-measure (2026-11-04, hidden 144 Hz output)**
One full 10-scenario matrix, Astra vs Firefox 159, **20/20 runs PASS**, while
the owner's video kept playing on `eDP-1`. The measured window ran on
`HEADLESS-1` at 144 Hz with `layout.frame_rate=144` pinned in both profiles
(Astra/ESR 153 otherwise resolves that output to 60 Hz). Single run and an
ambient iGPU at up to 100% in the 3D rows: treat differences under ~5% as noise.
- **mixed-8 CPU: 5.81 vs 4.23 cores (+37.3%) → 4.46 vs 4.34 (+2.7%).**
  7/7 background tabs were actually parked (`docActive=false`).
- **3d-4 PSS: 631 vs 478 MiB (+32.0%) → 566 vs 493 MiB (+14.9%)**;
  **3D GPU memory 462 vs 231 MiB (+100.3%) → 354 vs 317 MiB (+11.5%)**.
- **3D per-frame cost is now parity:** 3d-1 `gpu_render% / rAF` 0.406 vs 0.309
  (+31.6%) → 0.304 vs 0.314 (−3.2%); 3d-4 0.358 vs 0.353 (+1.4%).
- **Base memory did not move:** 1 tab 509 vs 429 MiB (+18.7%), 8 static
  555 vs 493 (+12.7%), video-6 736 vs 644 MiB (+14.3%). video-6 GPU memory
  improved (78.1% → 57.3% over stock) but is still high.
- **Runtime startup did not move:** spawn→UI ready 1.85–2.08 s vs stock
  1.49–1.59 s (+0.35–0.55 s), despite the −10.7% JS graph.
- Raw data: `out/stress-postfix-20261104-012722/`. No product code changed.

**Measured, not changed**
- `dom.ipc.processPrelaunch.fission.number` 3→1 did **not** reduce the observed
  content-process count (5 both) and PSS was 609 vs 646 MiB (noise). Do not ship
  a blind prealloc change. The 7-vs-4 gap likely includes the hidden stock
  tabbrowser, extension, privilegedabout and/or a second webIsolated process;
  audit with `ChromeUtils.requestProcInfo()` / `about:processes` first.
- The 3D compositor A/B cannot be measured on the private Weston display: it
  renders with **llvmpipe** and reports 0% DRM render. It needs a real iGPU
  display and the focus watchdog.

**Corrections from the ESR 153 source audit**
- `docShellIsActive` is the `<browser>` property: it sets
  `browsingContext.isActive` and remote `renderLayers`. Setting
  `browsingContext.isActive` alone leaves rendering on. Wake order:
  `docShellIsActive=true`, then `preserveLayers(false)`. Park order:
  `preserveLayers(false)`, then `docShellIsActive=false`.
- `manualactiveness="true"` is required before manual changes; without it Gecko
  re-derives activeness when the content process attaches or changes remoteness.
  With it, the visible tab must be set active explicitly or it does not paint.
- The pref is **`media.suspend-background-video.enabled` / `.delay-ms`** (not
  `media.suspend-bkgnd-video`). Deactivating a docshell does not pause media;
  video decode freezes after the delay, audio continues.
- There is **no chrome-side `WEBGL_lose_context`**. Background WebGL contexts
  idle but keep their GPU allocations. `docShellIsActive=false` + layer release
  stops CPU/GPU drawing, but the 3D GPU-memory target needs **discard/browser
  removal** (SessionStore + sleeping UI), not deactivation.
- `display:none` parking already tears down the presentation; the docshell
  deactivation is what fixes visibility, rAF and CPU. If switch latency
  regresses, move parked browsers to `-moz-subtree-hidden-only-visually:1`
  rather than re-enabling `preserveLayers`.

**Deferred (2026-11-04): first-load UX / preconnect / per-space warm pool.**
The spec is `docs/astra/FIRST_LOAD_UX_TESTCASE.md`; the diagnostic is
`tools/perf/stress/first_load_probe.py`. Measured cold-vs-warm baseline:
Google 6.13 s → 0.62 s; YouTube 2.48/6.70 s → 1.09/1.06 s. Do **not** implement
progressive reveal, speculative preconnect or a warm connection pool now.
No product code is touching it.

**Still open**
- Real-display 3D A/B: hide/clip the app layer under the content stage, measure
  `gpu_render_pct`/frame, then decide on the stage restructure.
- Discard/sleeping policy with SessionStore, scroll/form restore and exceptions.
- Startup wall time: the −10.7% JS graph did not move `spawn→UI ready`
  (still +0.35–0.55 s over stock); profile the shell boot path next.
- Process-table audit via `ChromeUtils.requestProcInfo()` before any
  `dom.ipc.*` change.
