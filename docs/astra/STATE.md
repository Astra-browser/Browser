# Astra task state (§1.2, §1.5) — the task-lock registry. Update + commit on every transition.

Legend: `todo` · `doing` (locked) · `blocked` · `done`. A `doing` row's Agent+Branch
lock it: no other agent may touch that task, its files, or its branch.

> **⚠️ CURRENT SCOPE — UI + WIRING (D-38, from 2026-11-03).**
> We build the interface and the route → host module → engine path it needs.
> A surface is done when it works in the packaged dev build, not when it
> renders. Empty, mock, disabled and `unknown_command` states are bugs when a
> real backend exists. Read `docs/astra/SCOPE.md` before picking up any task;
> pick from **Remaining wiring** below and close a row only when the live
> Marionette probe passes.

## Where things stand (2026-11-03 — read this first, next agent)

The browser builds, boots, and **the product UI is the window's chrome** (not a
page painted over Firefox). Phases 0–6 are done; the active lane is the
connected product surface: `ui/app` + `ui/shell` + the Host API and engine
hooks each one needs (D-38).

**Run it**

```sh
./tools/run-dev.sh            # reuse out/dev-profile
./tools/run-dev.sh --fresh    # clean profile
```

**Rebuild after a change**

```sh
bun run --filter @astra/frame build:chrome     # ui/app changed
bun run --filter @astra/shell-hello build      # ui/shell changed
(cd forge/astra-forge && cargo run -q -- overlay && cargo run -q -- build --faster)
```

`build --faster` repacks in ~7 s. Only an engine change (`engine/**`, C++/Rust)
needs the full build: `cargo run -q -- build --jobs 2` — **always cap jobs**,
an uncapped gkrust LTO link has OOM-killed this machine (BUILD_TIMES.md).

**Architecture in one paragraph.** `ui/app` (Svelte 5) is packaged as the
first-party document `chrome://astra/content/app/browser-chrome.html`
(jar.mn) and embedded by `ui/shell/src/app-frame.js` in a chrome-privileged
`<iframe>`. Same principal and process, so the bridge imports the Host API
directly (`resource://astra/host/HostAPI.sys.mjs`) — no relay, no `file://`,
no framescript. The app renders from `items-changed` projections and listens
on `astra:*` DOM channels; the chrome entry re-dispatches bridge events onto
those channels. Web pages stay content processes in the shell's content slot.

**Traps that cost real time — do not rediscover these**

- **Do not mount the app in-tree** in `browser.xhtml`. It was tried
  (2026-11-03) and reverted: the app's stylesheets are scoped to its own
  document (`#root`, `html`, `body`), so the address field went white, tab
  labels disappeared and the wordmark collapsed. D-35.
- **Do not remove the first-paint gate.** A chrome iframe caches the layer it
  painted while transparent; revealing it without invalidating both layers
  shows a half-built frame (the "appear → vanish → reappear" the owner
  reported). `app-frame.js` holds the frame at `opacity:0` until the app
  reports `ready`, then nudges both layers. D-35.
- **Patch ASTRA-0006 is load-bearing.** Svelte compiles every template through
  `template.innerHTML`; the default system-principal sanitizer strips
  `button`/`input`/`form`/`script`. Only `chrome://astra/` documents are
  exempt. Removing it silently breaks the mount.
- **`parseEnvelope` must keep a `null` payload.** `setting_get` returns
  `string | null`; coercing `null` to `{}` made every preference read back as
  an object, which silently disabled the clock, greeting and due-today pill.
- **Playwright cannot drive this binary.** It launches Firefox with
  `-juggler-pipe`, which Playwright's own fork speaks and our ESR build does
  not. Playwright stays on the standalone-Chromium lane
  (`ui/app/playwright.config.ts`); the dev build is driven over Marionette
  (`tools/marionette-probe/`).
- **Screenshots lie under Hyprland.** `grim` captures the last composited
  buffer; an unfocused/occluded window shows stale pixels. Match the window by
  **PID** (`tools/marionette-probe/framecheck2.py`) before believing a frame.

**Verification gates** (all green on `main`)

```sh
python3 tests/contract/shell_app_chrome.py   # 17 checks: chrome doc, root, host mode, first frame
node tests/contract/hostapi_v1.mjs           # 289 checks
node tests/contract/shell_assembly.mjs
node tests/contract/frame_model.mjs
(cd ui/packages/bridge && bun test)          # 25
(cd ui/app && bun run vitest run src/shared/ipc/bridge.test.ts)
python3 tools/state-check.py && bash tools/brand-lint.sh
(cd forge/astra-forge && cargo run -q -- lint && cargo run -q -- footprint)
```

### Remaining wiring (active backlog — D-38)

These are current work, not a parking lot. Each row needs a live probe before
it can be called done. The browser-core batch (history, bookmarks, favicons,
page menu, private/new windows, theme, loading, keyboard ids) is closed and
recorded below; this list is what is still genuinely unwired.

- **Split-pane content.** The app renders a split layout, but the content
  stage still shows one page. Needs one live `<browser>` per visible pane and
  a shell-side rect/visibility protocol.
- **Container-scoped opening.** The context menu can open a link in a new tab,
  window or private window, but not in a chosen Firefox container; there is no
  container picker in the Astra UI yet.
- **Guaranteed DevTools.** The shell asks `gDevTools.showToolboxForTab` for a
  synthetic tab. When the engine refuses a standalone browser, the action
  reports refusal and opens **no** Firefox window. Making this unconditional
  likely needs the content stage to be tabbrowser-backed, or an engine hook.
- **The remaining unrouted command ids.** Most of the 267 commands still have
  no Host route. Add them only with a UI caller, a route-table entry, a
  contract test and a live probe.
- **Host projection ownership.** `overlay/astra/host/Tabs.sys.mjs` still derives
  the projection; `astra-core` ownership is plan §5.4 work.
- **Real page surface under split/work panes.** The content stage has only
  been exercised with one page; multi-pane and Work pane relayout remain
  unverified.


## Phase 0 — Discovery, inventory, scaffolding

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P0-T01 | Machine/toolchain check (Linux) | done | orchestrator | main | DEV_SETUP.md facts + ESR 153.6.0 verified in UPSTREAM.md; build-reqs check deferred to P1-T04 |
| P0-T02 | Clean repo + record base snapshot | done | orchestrator | main | Repo on `main`, 14 commits; base = `folder_context` snapshot, see `PROVENANCE.md` |
| P0-T03 | Full inventory (crates, IPC, UI, storage, skills) | done | orchestrator | main | INVENTORY.md + ipc-surface.md (267/35) + PARITY.md; subs T03a/T03b merged |
| P0-T03a | IPC surface: every command/event + payloads | done | worker-1 | agent/P0-T03a-ipc-surface | Merged 2026-11-01; 267 cmds + 35 events, zero mismatches |
| P0-T03b | PARITY.md (README claims vs code) | done | worker-1 | agent/P0-T03b-parity | Merged 2026-11-01; no new deviations beyond X-01…X-06 |
| P0-T04 | KEEP/ADAPT/DROP + `BrowserHost` trait | done | worker-1 | agent/P0-T04-porting | Merged 2026-11-01; groups mapped to Host API modules |
| P0-T05 | Rebrand tooling + `brand-lint` | done | worker-1 | agent/P0-T05-rebrand | Merged 2026-11-01; lint exits 0 clean / 1 dirty |
| P0-T06 | License/provenance | done | worker-1 | agent/P0-T06-license | Merged 2026-11-01; MPL LICENSE + NOTICE + 25/25 permissive |
| P0-T07 | Golden capture harness | done | orchestrator | agent/P0-T07-golden | Merged 2026-11-02; 18/18 rerun green, brand-lint clean; shell text-raster variance documented in MANIFEST (mask/tolerance for P3-T11) |
| P1-T01 | `upstream.toml` + `forge fetch` (ESR 153.6.0, U-10 resolved) | done | worker-1 | agent/P1-T01-fetch | Merged 2026-11-01; sig OK via release key, engine extracted, baseline ee0912e |
| P3-T01 | UI into `ui/` Bun workspace (standalone track) | done | worker-2 | agent/P3-T01-ui | Merged 2026-11-01; typecheck 0 errs, tests 1062 pass, vite build exit 0 |
| P0-T08 | CI skeleton | done | worker-1 | agent/P0-T08-ci | Merged 2026-11-01; ci-fast (brand-lint/state-check/plan-check) green locally |
| P0-T09 | Spike briefs for U-01…U-13 | done | orchestrator | main | Index in `docs/astra/spikes/README.md`; spikes execute in Phase 1 |
| P0-T10 | Repo hygiene docs | done | worker-1 | agent/P0-T10-hygiene | Merged 2026-11-01; SECURITY/CONTRIBUTING/CODEOWNERS added |

## Phase 1 — Forge and skeleton (Linux)

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P1-T01 | `upstream.toml` + `forge fetch` (ESR 153.6.0, U-10 resolved) | done | worker-1 | agent/P1-T01-fetch | Merged 2026-11-01; sig OK via release key, engine extracted, baseline ee0912e |
| P1-T02 | `forge config` + `config/mozconfig.linux` (F-05 flags verified) | done | orchestrator | agent/P1-T02-forge-config | BUILD_FLAGS.md (3 F-05 corrections); `forge doctor` mozconfig check green; `./mach configure` complete, config.status proof |
| P1-T03 | Branding overlay | done | orchestrator | agent/P1-T03-branding | astra/branding rendered from toml (dev defaults); configure+build green; "Astra Nightly" window + placeholder art verified in GUI |
| P1-T04 | First full Linux build + sccache + dev loop | done | orchestrator | agent/P1-T04-build | Binary built (153.6.0esr, GUI-verified incl. chrome://astra/); BUILD_TIMES.md (~70 min, 16 GB objdir, -j8 OOM rule); faster loop ~2 s (U-02 closed, U-03 deferred); `forge build` added |
| P1-T05 | Overlay wiring (`chrome://astra/`, ASTRA-0001) | done | orchestrator | agent/P1-T05-overlay | overlay/astra (moz.build/jar.mn/HostAPI stub/hello) staged by `forge overlay`; ASTRA-0001 applied; `forge lint` clean; configure complete with /astra in DIRS |
| P1-T06 | `policies.json` + pref overrides (incl. Normandy/HR path from BUILD_FLAGS.md) | done | orchestrator | agent/P1-T06-policies | 15 impl-verified policies ACTIVE; mozilla.cfg autoconfig locks Normandy/shield/sponsored (contract 7/7 PASS) |
| P1-T07 | Endpoint audit tool | done | orchestrator | agent/P1-T07-endpoint-audit | Merged 2026-11-02; Go stdlib-only, vet+6pkgs pass, live-run gate PASS, brand-lint/state-check green |
| P1-T08 | Shell mount patch (ASTRA-0002) | done | orchestrator | agent/P1-T08-shell | #astra-root mounted, Svelte hello renders, FF chrome hidden (contract 5/5 PASS incl. nonzero-size guard; GUI-verified "Hello Tab", no toolbars) |
| P1-T09 | Sidecar spike (U-01) | done | orchestrator | agent/P1-T09-sidecar | Merged 2026-11-02; stdio wins (D-31), harness SPIKE PASS reproduced, cargo check clean, brand-lint/state-check green |
| P1-T10 | Content slot + URL bar via Host API stub | done | orchestrator | agent/P1-T10-content | Merged 2026-11-02; stub 33/33 + live 12/12 PASS reproduced, P1-T08 5/5 no-regress, brand-lint/state-check green |
| P1-T11 | Contract-test harness (geckodriver) | done | orchestrator | agent/P1-T11-contract | Merged 2026-11-02; forge test 8/8 PASS reproduced (fixture-only + full), lint/footprint still green, brand-lint/state-check green |
| P1-T12 | `forge export`/`import` round-trip + patch lint + footprint budget | done | orchestrator | agent/P1-T12-forge-rt | Merged 2026-11-02; build+lint+footprint green (14 lines/2 patches/0 P3), roundtrip PASS vs live engine, brand-lint/state-check green |

## Phase 2 — Core, storage and bridge

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P2-T01 | Bring over crates per PORTING_MAP (`BrowserHost`) | done | orchestrator | agent/P2-T01-crates | Merged 2026-11-02; workspace check+clippy clean, tests 44/44, zero tauri/wry, MPL headers, brand-lint clean |
| P2-T02 | `astra-proto` schemas + generated Rust/TS types | done | orchestrator | agent/P2-T02-proto | Merged 2026-11-02; 267/35 registries, cargo 6/6 + bun 7/7 + validate PASS, drift gate verified, brand-lint clean; fixed stale "8 channels" comment (10 renames); Specta full-typing deferred |
| P2-T03 | IPC transport (framing, backpressure, crash recovery) | done | orchestrator | agent/P2-T03-transport | Merged 2026-11-02; ipc 17+5 chaos + workspace 81/81, clippy 0, fmt clean; fixed proto from_str lint + T01 fmt leftovers |
| P2-T04 | `astra-store` (rusqlite + migrations, WAL) | done | orchestrator | agent/P2-T04-store | Merged 2026-11-02; schema v4 (29 tables), store 19/19 + workspace 59/59, clippy+fmt clean; rusqlite 0.40 (migration-compat) |
| P2-T05 | `GeckoHost` + `MockHost` | done | orchestrator | agent/P2-T05-geckohost | Merged 2026-11-02; host-trait 23/23 + workspace 95/95, clippy -D warnings clean, fmt+brand clean |
| P2-T06 | Host API v1 (Boot/Windows/Tabs/Navigation) | done | orchestrator | agent/P2-T06-hostapi | Merged 2026-11-02; stub 262/262 + live 30/30 reproduced, no-regress 33/33+py+5/5, jar.mn wired; chrome repack deferred to next engine build (faster attempt hit fresh-objdir link fail, binary untouched, obj-x86_64* 93MB stray noted for cleanup) |
| P2-T07 | History mirror into Places (`:visited`) | done | orchestrator | agent/P2-T07-history | Merged 2026-11-02; stub 27/27 + live 10/10 (VisitedQuery parity); jar.mn + HostAPI façade wired (incl. Session); no-regress 262+73+33 green |
| P2-T08 | `@astra/bridge` (Tauri-compat + mock mode) | done | orchestrator | agent/P2-T08-bridge | Merged 2026-11-02; ui 1069/1069 + bridge 19/19 reproduced, build + svelte-check clean, brand-lint clean; vitest.config tsc errors pre-existing |
| P2-T09 | Session snapshot/restore round-trip | done | orchestrator | agent/P2-T09-session | Merged 2026-11-02; workspace 129/129, session 73/73 + hostapi 262/262 no-regress, clippy/fmt/brand clean; jar.mn wired |
| P2-T10 | Settings, keymap, logging, diagnostics | done | orchestrator | agent/P2-T10-settings | Merged 2026-11-02; core 50/50, workspace 120/120, clippy/fmt/brand clean |

## Phase 3 — UI port, 1:1 (daily-driver browsing)

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P3-T01 | UI into `ui/` Bun workspace (standalone track) | done | worker-2 | agent/P3-T01-ui | Merged 2026-11-01; typecheck 0 errs, tests 1062 pass, vite build exit 0 |
| P3-T02 | Spike S-01 content slots (+ split/Work panes impl) | done | orchestrator | agent/P3-T02-slots | Merged 2026-11-02; CSS-grid slots (U-05 resolved), stub 39/39 + live 16/16, no-regress green; FIXED load-bearing P2-T06 regression (XUL_NS xhtml→xul, live-guarded) |
| P3-T03 | Window frame per OS (Linux first) | done | orchestrator | agent/P3-T03-frame | Merged 2026-11-02; model 27/27 + live 17/17, no-regress green; jar.mn wired; Shell mounting deferred to P3-T13 |
| P3-T04 | Tabs (vertical, pinned, folders, DnD, context menus) | done | orchestrator | agent/P3-T04-tabs | Merged 2026-11-02; ui 1084/1084 + shell model 13/13 reproduced, build + svelte-check clean; SpaceBar failure not reproduced (worker env) |
| P3-T05 | Spaces/profiles (S-02 + containers impl) | done | orchestrator | agent/P3-T05-spaces | Merged 2026-11-02; S-02 (spaces→containers, profiles→dirs), isolation 117/117, core 69/69, no-regress 262+73+27 green; jar.mn wired |
| P3-T06 | Split view + layout persistence | done | orchestrator | agent/P3-T06-split | Merged 2026-11-02; core 80 + shell 20/20 + ui 1096 green, layout rides Session host module (validated+echoed, schema updated, 99 checks) |
| P3-T07 | Omnibox + search | done | orchestrator | agent/P3-T07-omnibox | Merged 2026-11-02; ranking port + local engines + model, ui 1133/1133 + svelte-check clean; worker's 43 fails were stale-base env, not main |
| P3-T08 | Settings UI, shortcuts, theming | done | orchestrator | agent/P3-T08-settings | Merged 2026-11-02; surface pre-exists bridge-driven, platform-gated conflict test fixed; ui 1096 + svelte-check clean |
| P3-T09 | Browser dialogs via Host API events | done | orchestrator | agent/P3-T09-dialogs | Merged 2026-11-02; events 94/94 + spoof-resistance 27/27, no-regress 262+99 green; façade + jar.mn wired |
| P3-T10 | Welcome/onboarding flow | done | orchestrator | agent/P3-T10-welcome | Merged 2026-11-02; ui 1144/1144, registry-known keys verified in core, svelte-check + brand clean |
| P3-T11 | Golden suite (in-Firefox vs baseline) | done | orchestrator | agent/P3-T11-goldff | Merged 2026-11-02; 13/16 PASS reproduced, 3 text-raster FAILs + 2 narrow SKIP documented; CI job report-only until gate tuning |
| P3-T12 | Accessibility pass | done | orchestrator | agent/P3-T12-a11y | Merged 2026-11-02; A11Y checklist + landmarks/focus/contrast tests, ui 1153/1153, conflict vs T13 assembly resolved (landmarks kept); engine bundle refresh rides P3-T14 |
| P3-T13 | Shell assembly (mount frame/tabstrip/split, __astraHost wiring) | done | orchestrator | agent/P3-T13-assembly | Merged 2026-11-02; assembly 57 + all stub suites green, live-vs-current-binary green; TRUE live verify of new bundle needs rebuild (P3-T14) |
| P3-T14 | Engine rebuild + full live re-verify (new Host/chrome/shell bundle) | done | orchestrator | main | Rebuilt (faster, 8s); all live suites green on new binary; FIXED: localStorage guard (tabstrip/split), Frame URL, XUL dup div; frame_live rewritten to probe real shell; goldens recaptured 18/18 |
| P3-T15 | Mount full app (ui/app/dist) as the shell, retire hello | done | orchestrator | agent/P3-T15-appshell | Merged 2026-11-02; node green (1 pre-existing FAIL proven on main), py green, lint/brand/CSP clean; file:// + framescript relay (see SHELL_APP.md §5) |
| P3-T16 | Retire interim chrome when app boots (hide bar/split/sidebar/toolbar, keep titlebar+content) | done | orchestrator | main | Shell hides interim chrome on appReady=host; verified built+staged; live proof pending on deterministic boot (P3-T17) |
| P3-T17 | Deterministic app boot: fix content crashes + flaky mount, missing host routes | done | orchestrator | agent/P3-T17-appboot | Merged 2026-11-03 (79c1b7d): isStandalone resource:/chrome:/about: mock path (bridge 8/8, eslint clean); Sidebar + WebExtensions stubs via HostAPI (contract 289/289); slot-error dark contrast + #browser dead-space hide (frame_model PASS; shell_assembly 1 FAIL pre-existing on main, unrelated). Live proof needs engine rebuild (bundle restage). Follow-up RESOLVED 2026-11-03 (5e8c5d2): host-transport.ts ROUTES wired (bridge 25/25, smoke 1 passed) |
| P3-T18 | Playwright sync to Astra (standalone smoke + docs) | done | orchestrator | agent/P3-T18-playwright | Merged 2026-11-03 (bc3f23f): playwright.config.ts (baseURL 1420, chromium-1248) + smoke.spec.ts 1 passed (18.2s) + PLAYWRIGHT.md; --list clean; no remote to push (local-only). In-Firefox stays marionette lane. PROVEN 2026-11-03: Playwright cannot drive custom Gecko (launches with -juggler-pipe, ESR lacks it) |
| P3-T19 | Headed dev-build boot + live verify (rebuilt UI, ROUTES, shell bundle) | done | orchestrator | main | 2026-11-03: fixed shell_assembly test URL (res/→correct mapping) + jar.mn Sidebar/WebExtensions registration + rebuilt shell bundle (13/13 routes) + restaged 746-file chrome app; headed boot appReady=host, relay res:ok, ZERO BridgeErrors live, interim chrome retired ([hidden] x6), local fixture tab paints (title verified + content screenshot). Sandbox has no external net (example.com fails from shell too). Window left open for owner |
| P3-T20 | New Tab parity with the reference UI (real projection + chrome retirement) | done | orchestrator | main | Merged 2026-11-03 (e95c038/3727bc8). Root causes: parseEnvelope coerced null→{} (every preference read as an object → clock/due hidden); app listens on `astra:*` DOM channels the relay never dispatched; no items-changed projection (no tabs → no New Tab); interim titlebar/toolbar defeated [hidden] via author display and split the window 50/50. Added Tabs.bootstrap + projection, Settings, Accounts, sidebar.changed, astra:* re-dispatch, app-owns-window layout, typographic ASTRA wordmark. Live: sky + wordmark + clock + Sign in + tab row + 3 pills. Pill labels hidden <720px container by design. Contracts 289/289, shell_assembly/frame_model PASS, state/brand clean |
| P3-T21 | Real chrome integration: `chrome://` package document, relay deleted, skeleton-free boot | done | orchestrator | main | 2026-11-03. ASTRA-0006 (P3, `nsContentUtils.cpp`) exempts `chrome://astra/` from default system-principal innerHTML sanitization — the actual blocker; Svelte builds templates via `template.innerHTML`. App now loads as `chrome://astra/content/app/browser-chrome.html` in a chrome-privileged iframe, same principal, Host API imported directly; `file://` browser + `relay-framescript.js` + nonce deleted. Boot: `data-app-booted=pending` hides all fallback chrome, app ground fills the window (D-33); early captures 0.7–7.0 s show no skeleton. Proof: `tests/contract/shell_app_chrome.py` 11/11 PASS; forge lint 6/6 clean; hostapi 289/289, shell_assembly + frame_model PASS, bridge 25/25, app bridge test 8/8, svelte-check 0 |
| P3-T22 | Instant first paint: Space bar, tab row, drop target and account foot present when the UI appears | done | orchestrator | main | 2026-11-03. The sidebar could paint an empty shell and fill in a pass later. App now mounts behind an `opacity:0` gate and reveals only when the four sections are present for 3 consecutive frames (cap 1200 ms). `visibility` leaked through descendants (measured) — opacity cannot. Reveal measured at 271 ms document time. shell_app_chrome.py extended: first-visible-frame completeness + reveal budget. hostapi 289/289, shell_assembly/frame_model PASS, bridge 25/25, app bridge 8/8, svelte-check 0 |
| P3-T23 | First frame is the finished, correctly styled UI | done | orchestrator | main | 2026-11-03. Tried in-tree mount into browser.xhtml (rejected: app CSS is scoped to its own document — white address field, hidden tab labels, 13px wordmark). Kept the chrome iframe and fixed the real flicker: a chrome iframe caches the layer it painted while transparent, so revealing it showed a half-built frame. Loader now holds the frame at opacity:0 (layout live), waits for the app's `ready`, then invalidates both layers. First captured frame (out/headed-frames2/f00.png) is complete. shell_app_chrome.py 17/17; hostapi 289/289, shell_assembly + frame_model PASS, bridge 25/25, svelte-check 0, state/brand clean |

## Phase 4 — Browse core: blocker, extensions, import, privacy

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P4-T01 | `astra-blocker` crate (adblock-rust + seed lists) | done | orchestrator | agent/P4-T01-blocker | Merged 2026-11-02; blocker 23/23, workspace 223/223, seed byte-identical + attribution clean; NOTICE rebrand stands (own file) |
| P4-T02 | In-tree Rust network-hook component | done | orchestrator | agent/P4-T02-network | Merged 2026-11-02; in-tree chosen (precedent-verified), wiring 37/37 + lint/footprint green; added lint new-file carve-out; fixed PASSWORD_DECISION brand leak |
| P4-T03 | Element hiding (cosmetic + click-to-hide) | done | orchestrator | agent/P4-T03-hiding | Merged 2026-11-02; protocol+logic 36+44 green; live injection deferred to P4-T11 |
| P4-T04 | Extension manager + curated gallery | done | orchestrator | agent/P4-T04-extensions | Merged 2026-11-02; 45-entry AMO gallery (36 equiv/8 alt/1 none), ext 8+1, ui 1189/1189, svelte-check clean |
| P4-T05 | Importers (Chromium/Firefox/Zen/...) | done | orchestrator | agent/P4-T05-import | Merged 2026-11-02; 9 sources + store round-trip, 45/45, zero net deps; FIXED latent T03 tokio macros gap (workspace build now green) |
| P4-T06 | Tab sleeping policy | done | orchestrator | agent/P4-T06-sleeping | Merged 2026-11-02; policy 9/9, core 94/94, workspace 232/232, clippy/fmt/brand clean |
| P4-T07 | Private windows (nothing persisted) | done | orchestrator | agent/P4-T07-private | Merged 2026-11-02; guard + forensic tests green; host-excluded today, store wiring = caller contract (see PRIVATE.md status) |
| P4-T08 | Downloads manager + PDF viewer | done | orchestrator | agent/P4-T08-downloads | Merged 2026-11-02; ui 1176/1176 + svelte-check clean; bridge download routes stubbed (follow-up noted) |
| P4-T09 | Password/autofill decision | done | orchestrator | agent/P4-T09-password | Research merged; recommends extension-only; owner decision pending (OWNER_QUESTIONS #6 expanded) |
| P4-T10 | Performance baselines | done | orchestrator | agent/P4-T10-perf | Merged 2026-11-02; baselines recorded (startup/RAM/switch/scroll/blocker), scripts validated; confirm re-run after engine rebuild |
| P4-T11 | Element-hiding live wiring (content script, provider, store adapter, actor reg) | done | orchestrator | agent/P4-T11-livehide | Merged 2026-11-02; content_hide 59+py PASS, hostapi 262 no-regress, blocker 22, bridge 24, fmt/brand clean; live Marionette skip-gated (no geckodriver) |

## Phase 5 — Tasks, Notes, Time

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P5-T01 | Tasks domain (lists, priorities, NL parser) | done | orchestrator | agent/P5-T01-tasks | Merged 2026-11-02; tasks 31/31, workspace 284/284, clippy/fmt/brand clean |
| P5-T02 | Tasks UI + "make task" palette | done | orchestrator | agent/P5-T02-tasks-ui | Merged 2026-11-02; palette taskCommandRow + unit 83 + component 5/5; 2 pre-existing timing failures unchanged (proven identical stashed); PARITY stays ported-pending (no production caller yet) |
| P5-T03 | Notes (Markdown files + index + watcher) | done | orchestrator | agent/P5-T03-notes | Merged 2026-11-02; notes 12/12, workspace 253/253, clippy/fmt/brand clean |
| P5-T04 | Time tracking (per-site, focus mode) | done | orchestrator | agent/P5-T04-time | Merged 2026-11-02; time 12/12, workspace 296/296, clippy/fmt/brand clean; private-aware writes from day one |
| P5-T05 | Export/import (JSON + Markdown) | done | orchestrator | agent/P5-T05-export | Merged 2026-11-02; tasks/notes/time bundles + store import_json + combined fixture; tasks 15/notes 23/time 34/store 15+2, clippy/fmt/brand clean |

## Phase 6 — Work: agents, canvas, skills, MCP

| ID | Task | Status | Agent | Branch | Notes |
|---|---|---|---|---|---|
| P6-T01 | Agent design doc + `astra-agents` skeleton | done | orchestrator | agent/P6-T01-agentcore | Merged 2026-11-02; 27/27 + workspace 30 green; deeper machinery (shutdown proofs, plan-lease) deferred to P6-T02+ |
| P6-T02 | Provider layer (BYO + local, keychain keys) | done | orchestrator | agent/P6-T02-providers | Merged 2026-11-02; 34 unit + 27 conformance; keyring4+ureq3; keys redacted, live smokes opt-in |
| P6-T03 | Tool layer (browser/FS/command/MCP/gh) | done | orchestrator | agent/P6-T03-tools | Merged 2026-11-02; 60 unit + 27 conformance; 14 tools with schemas; MCP stdio + gh wrapper mocked |
| P6-T04 | Approval gate engine + injection suite | done | orchestrator | agent/P6-T04-approvals | Merged 2026-11-02; 59 lib (12-case injection suite) + 27 conformance; hash-chained audit; fail-closed |
| P6-T05 | Helpers (parallel sub-agents, containers, Panes) | done | orchestrator | agent/P6-T05-helpers | Merged 2026-11-02; agents 98+27, UI 6+5; fixed worker's premature handoff mod line (a3ebce9) |
| P6-T06 | Canvas UI (tables/charts/plans/code/docs) | done | orchestrator | agent/P6-T06-canvas | Merged 2026-11-02; unit 9/9 + component 3/3; goldens deferred (harness hardcodes 8 screens, see CANVAS.md); bundle-budget entry follow-up |
| P6-T07 | Skills: port 25 bundled (rebranded) + loader | done | orchestrator | agent/P6-T07-skills | Merged 2026-11-02; 25 full ports + skill-lint clean + SKILLS.md loader contract; runtime loader rides P6-T01 |
| P6-T08 | Memory + history recall (view/edit/delete) | done | orchestrator | agent/P6-T08-memory | Merged 2026-11-02; agents 32/core 96/store 29; hard-delete proven (raw SQL 0 + freelist 0); private-scope respected |
| P6-T09 | Hand-off to Claude Code / Codex | done | orchestrator | agent/P6-T09-handoff | Merged 2026-11-02; 110+8+27; scoped grants, approval-gated, ETXTBSY-hardened spawn; merge needed mod-line restore |
| P6-T10 | Port `eval/agentic-browsing` to `tests/eval/` | done | orchestrator | agent/P6-T10-eval | Merged 2026-11-02; 21/21 + smoke 5/5 + cap-negative; note: contract-runner has same log_message flaw, left untouched (follow-up) |


## Bugfix batch — owner-reported browser core (2026-11-03)

The owner reported the browser's everyday behaviour as broken (page menu,
history, Back/Forward, favicons, private windows, search, theme). This batch
wires **only** the surfaces named here; D-36 still governs everything else.
Live evidence is the Marionette probe run against the packaged dev build
(`19 passed, 0 failed`) plus a menu-bridge probe that suppressed the engine
menu and ran a row end-to-end.

| ID | Fix | Status | Branch | Evidence |
|---|---|---|---|---|
| B-01 | Hidden sidebar's peek card no longer swallows page clicks | done | `fix/sidebar-peek-clicks` | frame clipped to the card; `elementFromPoint` outside the card returns the page |
| B-02 | Back/Forward never lands on the empty New Tab; duplicates collapse | done | `fix/nav-history` | `hostapi_v1` 306 checks incl. A→B→Back→Forward and external adoption |
| B-03 | Bookmarks stored and read from Places (list/reveal/search/add/rename/move/remove) | done | `fix/bookmarks` | `bookmarks_model` 186 + live `bookmark.add` wrote the page |
| B-04 | Google is the default engine; content `prefers-color-scheme` follows the app | done | `fix/search-theme` | `search_model` 37, `system_model` 92, live pref 2→app choice |
| B-05 | Browsing history recorded and read from Places; site favicons resolved | done | `fix/history-favicons` | `history_places` 37, `favicons_model` 39, live visit + icon |
| B-06 | Astra owns the page menu; private/new windows; loading state; keyboard ids | done | `feat/astra-owns-context-menu` | engine menu prevented, app menu ran "Open Link in New Tab"; private window renders private chrome; new window adopts its URL |
| B-07 | Site icon fallback when Places has none | done | `fix/favicon-fetch-fallback` | live icon for a site the engine never stored |
| B-08 | App theme reaches content through the boot channel | done | `fix/theme-content-scheme` | live pref changes from system (2) to the app's choice |
| B-09 | Agent worktrees excluded from `brand-lint` | done | `feat/astra-owns-context-menu` | gate clean with worktrees present |

**Still deferred after this batch (do not report as fixed):** real split-pane
content (the split layout is still a single page), container-scoped link
opening, and a guaranteed DevTools toolbox (the shell asks `gDevTools` for a
toolbox on the standalone browser and reports refusal without opening a
Firefox window). Media transport rows delegate to the engine's own
`nsContextMenu.mediaCommand`, so they act on the exact element clicked.

## Later phases

P7–P11 all `todo` — see `plan.md` §§8–11.
