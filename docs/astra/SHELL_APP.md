# Full-app shell (P3-T15 → P3-T21)

> Status (P3-T21, first paint P3-T23): the product UI **is** the browser
> chrome. `ui/app` ships as the first-party package document
> `chrome://astra/content/app/browser-chrome.html` and the main window embeds
> it in a chrome-privileged `<iframe>` (`ui/shell/src/app-frame.js`). Same
> principal, same process: the app imports the Host API directly
> (`resource://astra/host/HostAPI.sys.mjs`). There is no `file://` page, no
> out-of-process content browser, no framescript and no message relay.
> The first visible frame is guaranteed complete (§0b).
>
> The one engine change this needs is patch **ASTRA-0006**: documents whose
> URI begins `chrome://astra/` are exempt from the *default* system-principal
> `innerHTML` sanitization (`dom/base/nsContentUtils.cpp`,
> `IsAstraTrustedChromeDocument`). Svelte compiles every component template
> through `template.innerHTML`; the sanitizer strips
> button/input/form/script, so without the exemption a chrome-privileged
> mount cannot work. The package is first-party, fully bundled, with no
> remote or user-controlled markup; explicit `setHTML`/`setHTMLUnsafe`/
> ParserUtils callers keep their own flags. Rationale: `DECISIONS.md` D-32.
>
> Boot is skeleton-free (D-33): the shell's interim titlebar/toolbar/sidebar/
> split/status strip is a failure-only surface. While the app boots the frame
> carries `data-app-booted="pending"`, all fallback chrome is `display:none`,
> and the app's ground colour fills the window, so the first painted frame is
> the product UI.

## 0. History (superseded)

P3-T15 mounted the same bundle through a remote content `<browser>` pointed at
a `file://` URL plus a `relay-framescript.js` message bridge. That existed only
because a system-principal document sanitizes `innerHTML`; ASTRA-0006 removes
the cause, and P3-T21 deleted the workaround (browser, framescript, nonce and
relay dispatch are gone).

## 0b. First paint (P3-T23, 2026-11-03)

The app stays in its **own chrome document** (iframe). An in-tree mount into
`browser.xhtml` was implemented and reverted the same day: the app's
stylesheets are scoped to its own document (`#root`, `html`, `body`), so the
address field, tab labels and wordmark broke. D-35.

What looked like "sections loading late" (and later "UI appears, vanishes,
reappears") was a compositor detail: a chrome iframe caches the layer it
painted **while transparent**, and revealing it showed the half-built frame.
The loader therefore:

1. keeps the frame at `opacity: 0` from creation (layout stays live, so the
   app can measure itself and settle),
2. waits for the app's `ready` — the entry only announces after the Space bar,
   tab row, essentials drop target and account foot have been present for
   three consecutive frames (cap 1200 ms),
3. reveals and invalidates **both** layers (element `transform` nudge + child
   `documentElement` opacity toggle) so the cached half-frame cannot survive.

Proof: `out/headed-frames2/f00.png` — the first captured frame of the window —
is already the complete UI. `tests/contract/shell_app_chrome.py` asserts it.

## 1. What changed and why

P1-T08 proved Svelte-under-chrome-CSP with a minimal hello bundle
(`@astra/shell-hello` → `overlay/astra/chrome/shell/shell.mjs`). P3-T15 keeps
that proof intact (`chrome://astra/hello.html` still staged as the diagnostic
page; `<Hello/>` still rendered in the shell's "Shell status" details) and
mounts the ported product UI (`ui/app/`) as the shell content:

- The app boots in **HOST mode** inside Firefox: the chrome entry
  (`ui/app/chrome-entry/browser-chrome.ts`) calls `ensureBridge`, which
  imports the Host API modules directly (`resource://astra/host/HostAPI.sys.mjs`)
  and dispatches through the existing host transport
  (`createHostDispatch`). No relay, no nonce, no message manager.
- Outside the browser (`file:`/`http(s):`/`about:`/`resource:` direct opens)
  the same bundle falls back to the existing mode detection
  (`ensureBridge`: MOCK host), so dev previews and goldens keep working.
- The bridge bus is re-dispatched onto the `astra:*` DOM channels the UI
  subscribes to (`native-events.ts`); in the Tauri build Rust did that, and
  the chrome entry now does it in-process.
- If the app fails, the shell reveals its fallback chrome and the entry
  renders an `Astra unavailable: …` alert into `#root` (message + trimmed
  stack, mirrored into the document title).
- Boot state is observable live: `#root[data-bridge-mode="host"]` in the app
  document, `data-app-booted` (`pending`/`true`/`false`) plus
  `data-app-ready` on the shell mount.

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
- `ui/app/browser-chrome.html` + `ui/app/chrome-entry/browser-chrome.ts`:
  same `#root` document shape as `browser.html`; the entry boots HOST mode
  (`ensureBridge` → direct Host API import), re-dispatches bridge events onto
  the `astra:*` DOM channels, mounts, and posts `{ns:"astra-shell",
  kind:"ready", mode}` to the embedding shell.
- `ui/app/scripts/stage-chrome.mjs` (stdlib only): regenerates the
  `# BEGIN/END CHROME APP` block in `overlay/astra/jar.mn` (sorted, one line
  per staged file — no hashed names hardcoded anywhere; the document loads
  through `chrome://astra/content/app/`), then audits chrome-CSP
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
  (`app-frame.js`) creates a chrome-privileged `<iframe>` in
  `.astra-app-mount` (`data-astra-app`) pointing at the package document and
  waits for the app's `ready` handshake. The interim bar/split/slot mounts
  stay wired but are `display:none` unless boot fails (D-33).

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

## 5. Why the earlier shape was rejected (measured 2026-11-02, superseded 2026-11-03)

> Kept for the record. P3-T21 replaced all of it: the sanitizer is now
> exempted for `chrome://astra/` (ASTRA-0006), a chrome-privileged iframe
> loads the package document directly, and the relay below is deleted.

Every simpler mount was probed live (headless engine build, Marionette
chrome context) and failed for a Firefox-mechanical reason:

- ~~Subframe navigation to `chrome://` fails~~ — re-measured 2026-11-03: a
  chrome-privileged iframe **does** load
  `chrome://astra/content/app/browser-chrome.html` (the earlier probe used a
  URL that was not yet staged in jar.mn). What actually blocked the mount was
  the sanitizer below.
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
