# Full-app shell (P3-T15)

> Status: the running browser mounts the real product UI — not the P1-T08
> hello skeleton — as the shell. `chrome://astra/app/browser-chrome.html`
> (packaged from `ui/app`, golden-verified sources, HOST-mode bridge) loads
> in a content `<browser>` inside `#astra-root`, driven by the shell loader
> (`ui/shell/src/app-frame.js`, wired in `Shell.svelte`).

## 1. What changed and why

P1-T08 proved Svelte-under-chrome-CSP with a minimal hello bundle
(`@astra/shell-hello` → `overlay/astra/chrome/shell/shell.mjs`). P3-T15 keeps
that proof intact (`chrome://astra/hello.html` still staged as the diagnostic
page; `<Hello/>` still rendered in the shell's "Shell status" details) and
mounts the ported product UI (`ui/app/`) as the shell content:

- The app boots in **HOST mode** inside Firefox: the chrome entry
  (`ui/app/chrome-entry/browser-chrome.ts`) configures the bridge with a
  relay dispatch that terminates in the shell's Host API modules, instead of
  the in-memory MOCK host. No host-vs-mock logic was changed — the relay
  terminates in the existing host transport (`createHostDispatch`).
- Outside the shell (no relay handshake: `file:`/`http(s):` direct opens)
  the same bundle falls back to the existing mode detection
  (`ensureBridge`: MOCK host), so dev previews keep working.
- If the Host API is unavailable the shell shows
  `Host API unavailable outside the browser window` in the app region
  (existing `slot-error` pattern) and the interim P1-T10/P3 bar/split/slot
  chrome stays visible; the app entry itself renders an
  `Astra unavailable: …` alert into `#root` (message + trimmed stack, and the
  document title, which is readable cross-process) if its own boot fails.
- Boot mode is observable live: `#root[data-bridge-mode="host"]` in the app
  document, `data-astra-app[data-app-ready="host"]` + relay counters
  (`data-relay-seen`, `data-relay-hello-error`) on the shell mount.

## 2. Build path (`ui/app` → overlay)

One command (documented, reproducible, deterministic file list):

```sh
bun run --filter @astra/frame build:chrome
```

which runs `vite build --config vite.chrome.ts` and then
`node scripts/stage-chrome.mjs`. The pieces:

- `ui/app/vite.chrome.ts` (additive; app sources untouched): reuses
  `frameConfig(["browser"])` — same Svelte/Tailwind/i18n/code-splitting as
  the golden build — overriding only packaging:
  `input` → new `browser-chrome.html` (HOST-mode entry, no panel/onboarding:
  separate surfaces), `base` → `"./"` (absolute `/assets/…` would resolve
  against the wrong root), `outDir` → `overlay/astra/chrome/app/`, and
  `@tauri-apps/api/{core,event,window}` → the `@astra/bridge` Tauri shim (no
  Tauri runtime in Firefox; the shim routes through the bridge). Verified:
  the staged bundle contains no `__TAURI_INTERNALS__` reference.
  `astra-bootstrap-boundaries` is dropped from this config only — it pins the
  golden page set/entry names (`/browser.html` facade, recorded byte
  budgets) — so the golden `build`/`budgets` gates stay authoritative.
  `output.sanitizeFileName` maps Vite's `~`-joined merged-chunk names to
  `-` (`messages~AboutPage-HASH.js` → `messages-AboutPage-HASH.js`): `~` is
  illegal in jar.mn and breaks `mach build faster` at jar parsing.
  `stage-chrome.mjs` owns the chrome-specific audits instead.
- `ui/app/browser-chrome.html` + `ui/app/chrome-entry/browser-chrome.ts`
  (new, additive): same `#root` document shape as `browser.html`; the entry
  waits for the shell's `hello` (up to 30 s), then configures host-via-relay
  and mounts, announcing `ready` with its bridge mode.
- `ui/app/chrome-entry/relay-framescript.js` (new, plain script — must NOT
  go through the bundler): loaded per-browser by the shell, forwards the
  entry's relay frames up via `sendAsyncMessage` and re-posts chrome's
  replies down into the page.
- `ui/app/scripts/stage-chrome.mjs` (stdlib only): restores static files
  (the framescript — wiped by `emptyOutDir`), regenerates the `# BEGIN/END
  CHROME APP` block in `overlay/astra/jar.mn` (sorted, one line per staged
  file — no hashed names hardcoded anywhere; the loader resolves the page
  through the `resource://astra-app/` mapping), then audits chrome-CSP
  safety (U-04): no inline `<script>`, no remote `http(s):` script/link URLs,
  no absolute-path subresources. Output names stay hashed (cache-busting).

## 3. Packaging (`overlay/astra`)

- `overlay/astra/chrome/app/**`: generated bundle (~740 files, ~12 MB).
  Committed like `chrome/shell/` so `forge overlay` stages it with the same
  `cp -a` (no UI toolchain needed at overlay time) and the running build is
  reproducible from the lockfile. Rebuild any time with the command in §2.
- `overlay/astra/jar.mn`: `content/astra/app/<file> (chrome/app/<file>)`
  lines inside the generated block (`chrome://astra/app/…`, kept working
  but unused for framing — see §5) plus `% resource astra-app
  %content/astra/app/` so the shell can resolve the staged page to a
  `file://` URL at runtime (no path hardcoded). Hand edits go outside the
  markers; the script rewrites only the block.
- `overlay/astra/chrome/shell/shell.mjs` + `shell.css`: rebuilt from
  `ui/shell/src/` (`bun run --filter @astra/shell-hello build`); the loader
  now mounts `app-frame.js`: resolves the app page to `file://`, creates a
  remote content `<browser>` in `.astra-app-mount` (`data-astra-app`), loads
  the relay framescript, and relays envelopes/events with a per-mount nonce.
  The interim bar/split/slot mounts stay visible and wired as the fallback.

## 4. Verify

```sh
bun run --filter @astra/frame build:chrome   # chrome bundle + jar.mn + CSP audit
bun run --filter @astra/shell-hello build    # shell loader (only after ui/shell/src edits)
forge overlay                                # stages overlay/astra → engine/astra
forge lint                                   # patch headers (unchanged set)
forge build --faster                         # incremental; reload
tools/brand-lint.sh                          # clean (generated dir excluded, see §6)
node tests/contract/*.mjs                    # stub suites green
python3 tests/contract/*.py                  # shapes green (live Marionette runs work here)
```

GUI ground truth (orchestrator/human): the window shows the product UI, not
the hello skeleton; toolbox stays hidden (P1-T05 CSS unchanged). Live suites
(`content_slot.py`, `frame_live.py`) drive the interim slot/tab chrome while
the app boots concurrently — all green, no interference.

## 5. Why this shape (measured, 2026-11-02)

Every simpler mount was probed live (headless engine build, Marionette
chrome context) and failed for a Firefox-mechanical reason:

- Subframe navigation to `chrome://` or `resource://` fails in this build
  config (`No chrome package registered` / silent error events) — even for
  the long-registered `chrome://astra/hello.html`. Only top-level loads
  work, so an iframe `src` is out.
- `about:blank` iframe + fetch + `document.write` DOES boot the app, but
  the resulting system/about-principal document **sanitizes innerHTML**
  (drops `button`/`input`/`form`/`script` — see `ShouldSanitize` in
  `engine/dom/base/nsContentUtils.cpp`), and Svelte builds every template
  with innerHTML, so the app dies in `document.importNode` on its first
  component. No overlay-side code can lift that sanitizer.
- Hence: a **remote content `<browser>`** (like the P1-T10 slot) pointed at
  the staged files via `file://` (resolved from `resource://astra-app/` at
  runtime). `file://` documents carry a content principal — no sanitizer,
  Svelte works — and module scripts resolve same-directory.
- `window.parent.postMessage` from out-of-process content never reaches the
  chrome window (measured: zero messages delivered), so the relay goes over
  the **message manager** with a per-browser framescript (loaded
  post-commit: the mm object is replaced across navigations, and a cached
  pre-commit manager throws `NS_ERROR_NOT_INITIALIZED`; framescript posts
  arrive with a null source, so the entry authenticates by namespace + nonce,
  never by `event.source`).

## 6. Brand-lint note

The staged bundle contains the previous product name *only* inside the
compiled Appendix C `prev:`→`astra:` event-rename map (`EVENT_RENAMES`,
from read-only `ui/packages/bridge/src/` via the generated
`ui/app/src/shared/ipc/bindings.ts` exception) — functionally required for
compat, same reason `dist/` build outputs are excluded from the lint.
`tools/brand-lint.sh` therefore excludes the generated
`overlay/astra/chrome/app/` dir (identical rationale, recorded here instead
of silently). Audit any time with:

```sh
grep -rIo "zeph[i]um" overlay/astra/chrome/app/assets | sort | uniq -c | sort -rn | head
```

— every hit must be a `prev:`-channel rename string. If a hit appears in
`browser-chrome.html`, titles, or visible copy, that is a rebrand regression:
fix in `ui/app` sources (P3-T01 rebrand), rebuild, restage.

## 7. Known follow-ups (not this task)

- The P3 window frame (titlebar/toolbar/sidebar/tab strip) stays visible
  around the app; the app brings its own sidebar/tabs, so navigation UI is
  duplicated until a later phase retires the interim frame.
- Only the `browser` surface is packaged; `panel`/`onboarding` are separate
  surfaces and stay out of `chrome://astra/app/`.
- `file://` resolution assumes flat chrome (dev `faster` builds); a packed
  build (`omni.ja`) would resolve to `jar:file://…` and the loader reports
  `packaged app not on disk` instead of mounting — packaging that is P8 work.
