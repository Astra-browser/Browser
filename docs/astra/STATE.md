# Astra task state (§1.2, §1.5) — the task-lock registry. Update + commit on every transition.

Legend: `todo` · `doing` (locked) · `blocked` · `done`. A `doing` row's Agent+Branch
lock it: no other agent may touch that task, its files, or its branch.

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
| P2-T07 | History mirror into Places (`:visited`) | doing | worker-t07h | agent/P2-T07-history | Locked 2026-11-02; owns overlay History module + mirror doc only |
| P2-T08 | `@astra/bridge` (Tauri-compat + mock mode) | done | orchestrator | agent/P2-T08-bridge | Merged 2026-11-02; ui 1069/1069 + bridge 19/19 reproduced, build + svelte-check clean, brand-lint clean; vitest.config tsc errors pre-existing |
| P2-T09 | Session snapshot/restore round-trip | done | orchestrator | agent/P2-T09-session | Merged 2026-11-02; workspace 129/129, session 73/73 + hostapi 262/262 no-regress, clippy/fmt/brand clean; jar.mn wired |
| P2-T10 | Settings, keymap, logging, diagnostics | done | orchestrator | agent/P2-T10-settings | Merged 2026-11-02; core 50/50, workspace 120/120, clippy/fmt/brand clean |

## Later phases

All `todo` — see `plan.md` §§8–11.
