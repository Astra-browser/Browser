# First-load UX — acceptance test case (spec only)

> **Status: DEFERRED, 2026-11-04 — do not build in prod for now.**
> This is a retained specification, not a scheduled task. **No product code was
> or will be changed by this document.** Revisit when first-load UX is picked
> up again.
> This is the test to implement *after* the first-load design is agreed.
> Current build: `bd9970a`. Measured current behaviour is in §6.

## 1. What this test is for

A first visit to a site is cold: DNS, TLS, HTTP/3 fallback, service worker and
the site's first JS are paid once. A second tab to the same site reuses all of
that. The test separates **network cold-start**, **Astra's reveal state**, and
**warm reuse** so we can prove which one is slow.

The intended UX is:

1. **Reveal at first paint, not at full load.** Once the document has painted,
   the skeleton must be gone; a small progress indicator may remain for
   subresources.
2. **A first visit may take longer than a warm visit, but the page must not be
   hidden behind the skeleton after it has painted.**
3. **A warm visit must be fast and must not redo cold work.**
4. **Preconnect follows intent**, not blanket page loading: address-bar input,
   link click, tab restore and a small per-space warm pool.
5. **Private windows and different spaces never share warm state.**

## 2. Preconditions

- Fresh profile with an empty HTTP cache, DNS cache and no service workers.
- Network working; close other major downloads.
- One Astra window, one New Tab, no page loaded.
- For deterministic runs, a loopback fixture server may replace the live site;
  the live Google/YouTube run is the realistic acceptance.

## 3. Test A — cold first visit, then warm second tab (Google)

| Step | Action | Expected after the fix | Current build |
|---|---|---|---|
| A1 | Type `google.com`, press Enter, start a stopwatch | navigation starts; skeleton may show until commit | same |
| A2 | Watch the content stage | **page appears at first contentful paint**, skeleton removed; a subtle progress indicator may remain | skeleton stays until `loading=false` (full load) |
| A3 | Record first-contentful-paint and full-load times | first paint < 1.0 s on a normal network; full load may be later | first `loading=false` measured **6.13 s** (run 1) / 1.07 s (run 2) |
| A4 | Open a second tab, type `google.com`, Enter | warm load **≤ 1.2 s**, no skeleton after commit, same-origin process/connection reused | measured **0.62 s** / 0.83 s |
| A5 | Check `about:networking#dns` and `#sockets` | second tab adds no DNS lookup; connection/session reused | expected |
| A6 | DevTools → Network → document → Timing | first: DNS/Connect/TLS/TTFB visible; second: cached/reused fields near zero | expected |

## 4. Test B — cold first vs warm second (YouTube)

Same steps as Test A with `youtube.com`.

| Metric | Current first | Current second | Target |
|---|---:|---:|---:|
| `loading=false` | **2.48 s** (run 1) / **6.70 s** (run 2) | **1.09 s** / **1.06 s** | first paint < 1.5 s; second ≤ 1.2 s |
| Skeleton after paint | still shown until full load | short | must be gone at first paint |
| Service worker / cache | cold | warm | warm must be reused |

Acceptance also checks that the first visit does **not** wait for every YouTube
subresource before revealing the document.

## 5. Test C — intent preconnect

1. Focus the address bar and type `youtube.com` **without** pressing Enter.
2. Wait 300–500 ms.
3. Open `about:networking#sockets` / `#dns`.

Expected after the fix:
- one DNS result and a TCP/TLS connection to `youtube.com` exist **before**
  the navigation request;
- no document/network request is made for the page itself;
- pressing Enter now reaches first paint faster than a cold A/B run.

Must not happen:
- preconnect in a private window;
- preconnect to a different space's history;
- page prefetch without explicit intent.

## 6. Test D — per-space warm pool

1. In space 1, load `google.com` in two tabs → second is warm.
2. Switch to space 2, load `google.com` in a new tab → **cold again** (separate
   container/cache); the test must not share cookies or cache across spaces.
3. Open a private window, load `google.com` → no preconnect, no shared cache.
4. The warm pool may preconnect to a few space-1 origins at idle, but it must
   not issue page requests and must be disabled in private windows.

## 7. Test E — regressions

- **Slow server:** a loopback server holds the response for 600 ms. The
  skeleton stays until the first byte, then clears; measured **~486–523 ms**
  total. No 15 s.
- **Fast local page:** clears in **181–273 ms**; no skeleton over the painted
  page.
- **Error page:** DNS failure/timeout shows the error page, not a skeleton
  forever; a capped message appears.
- **Background tab:** loading in a background tab does not keep the foreground
  skeleton; switching shows the page.
- **Audio/video:** background audio continues; video decode may suspend after
  the engine delay but playback time continues.
- **No data loss:** closing/reopening a tab does not lose scroll/form state
  beyond the existing session behaviour.

## 8. Instrumentation

- `PerformanceObserver` for `first-contentful-paint` and `largest-contentful-paint`.
- DevTools → Network → document → Timing: DNS, Connecting, TLS, Waiting, Content.
- `about:networking#dns` before/after; `#sockets` for reuse.
- `about:cache` for the second-tab hit.
- Browser probe: `tools/perf/stress/first_load_probe.py` (first vs second;
  current raw results in `out/first-load.json`).
- Keep the loading probe `tests/contract/load_state.py`: `data-loading` must be
  absent once the page is visible, independent of network speed.

## 9. Pass/fail

Pass only if **all** are true:

- first visit: page visible at first paint, skeleton gone;
- skeleton never covers an already-painted document;
- second same-origin tab: warm, ≤ 1.2 s, no DNS lookup;
- no 15 s stall on a slow first byte;
- preconnect only after intent and never in private/different spaces;
- error/timeout never leaves a permanent skeleton.

Current build fails the "reveal at first paint" part on slow sites; it passes
the fast/slow local loading and lifecycle tests. That is the gap this test is
meant to expose before any code changes.
