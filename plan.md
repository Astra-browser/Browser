# Astra — Master Build Plan (Agent Edition)

> **Version:** 1.0 · **Date:** 2026-11-01 · **Owner:** rem
> **Platform order:** Linux → Windows → macOS
> **What Astra is:** a Gecko/Firefox-based browser and work environment. It carries over Astra's complete feature set and its UI 1:1, rebuilt on Firefox's engine so the same engine runs on every platform. All branding is Astra. Accounts, sync and new AI-browser features are Astra's own.
> **Audience:** autonomous AI coding agents (Claude Code, Codex, etc.) plus the human owner. Self-contained: an agent can start from this file alone.

---

## 0. TL;DR

1. **Engine:** Firefox **ESR 153** (current ESR as of 2026-11-01). Annual jump to the next ESR (175, planned 2027-06-29). Never track the 2-week rapid-release train.
2. **Repo model:** *not* a long-lived fork. A **pinned upstream version + ordered patch series + overlay tree**, assembled by a Rust tool called **`astra-forge`**. Bumping Firefox = change one version, run one command, read one report.
3. **UI:** Astra's Svelte UI becomes the *only visible chrome*. Firefox's own chrome is hidden first, removed later. Tabs are Firefox `<browser>` elements placed by CSS inside Astra's layout.
4. **Brain:** Astra's Rust core becomes **`astra-core`**, a sidecar child process (SQLite via rusqlite). The Svelte UI talks to it through a bridge that mimics Astra's Tauri command/event surface, so UI code ports with minimal edits.
5. **Seam against upgrade pain:** everything Astra owns talks to Firefox only through one small, versioned **Host API** with contract tests. When Firefox changes, only the Host API module is fixed.
6. **Tooling:** Rust everywhere possible; **Bun** = package manager, workspace runner, test runner and any JS servers; **rusqlite** for SQLite.
7. **Order of work:** Phase 0 inventory → 1 forge+skeleton (Linux) → 2 core+bridge → 3 UI port → 4 blocker/extensions/privacy → 5 tasks/notes/time → 6 Work (agents) → *Linux parity beta* → 7 accounts+sync → 8 Linux GA → 9 Windows → 10 macOS → 11 Astra-exclusive AI features.

---

## 1. How agents must use this document

### 1.1 Operating rules (apply to every task)
- **No guessing of facts.** Anything labelled *UNVERIFIED* (see §4.3) must be checked before depending on it. Never invent URLs, crate/package names, Firefox build flags, or API signatures. Verify first.
- **Tools:** use **Context7** for current library docs (Rust crates, Bun, Svelte, Vite, etc.). Use **Firecrawl** (or any web fetch) for Firefox source docs (`firefox-source-docs.mozilla.org`), Searchfox, Bugzilla, MDN, and Mozilla release pages. Resolve the *current* stable version of every dependency at implementation time; do not hardcode versions from this document.
- **Smallest possible upstream footprint.** Prefer in this order: config/policies/prefs → overlay files → tiny hook patches (≤ 15 lines) → structural patches (needs owner approval + written justification).
- **Everything is test-gated.** A task is not done until its acceptance test exists, passes locally, and passes in CI.
- **Brand hygiene.** Never introduce the strings of the previous product name (any case variant) outside allow-listed provenance files (§3). CI enforces this.
- **Stop and ask the owner** (write to `docs/astra/OWNER_QUESTIONS.md`, do not guess) for: logo/artwork, domain names, bundle/app IDs for release, update-server hostname, code-signing certificates, any legal doubt, any patch that would exceed the upstream-footprint budget.
- **Commit hygiene:** one logical change per commit; conventional-commit prefixes (`feat:`, `fix:`, `patch:`, `test:`, `ci:`, `docs:`, `chore:`); every upstream patch has a header (see §6.3). **Commit every change:** no task's work stays uncommitted — commit when the task completes, and commit checkpoints for multi-step tasks. Never batch several tasks into one commit.
- **Orchestration model (§1.5).** One orchestrator agent plans, assigns, tests and reviews; worker subagents execute exactly one locked task each on their own branch. No agent touches a task or branch locked by another agent.

### 1.2 Progress tracking files (create in Phase 0, keep updated)
| File | Purpose |
|---|---|
| `docs/astra/STATE.md` | Table of all task IDs with status (`todo / doing / blocked / done`), owning agent, branch, PR link, notes — the task-lock registry (§1.5) |
| `docs/astra/DECISIONS.md` | ADR log; start from §2 of this plan. New decisions get a new `D-xx` entry |
| `docs/astra/OWNER_QUESTIONS.md` | Blocking questions for the human owner |
| `docs/astra/PARITY.md` | Feature parity matrix (generated in P0, kept live; see §7) |
| `docs/astra/UPSTREAM.md` | Current Firefox base, patch-health report, last bump notes |
| `docs/astra/PROVENANCE.md` | What was derived from Astra, with license text and attribution |

### 1.3 Task ID convention and lanes
Task IDs are `P<phase>-T<nn>`. Work is split into parallel **lanes**; agents on different lanes should not touch the same files.

| Lane | Scope |
|---|---|
| **A — Forge/Engine** | `forge/`, `patches/`, `astra/` overlay, Firefox build config, packaging, updater |
| **B — Core (Rust)** | `crates/*`, SQLite, IPC, blocker, agents runtime, sync client |
| **C — UI** | `ui/*` Svelte app, bridge shim, visual-parity work |
| **D — Quality/CI** | tests, golden screenshots, CI/CD, perf and security gates |
| **E — Cloud** | accounts + sync server, update server, website/docs (Bun where JS fits) |

### 1.4 Definitions
- **Definition of Ready:** inputs exist, verification items resolved, acceptance test described.
- **Definition of Done:** code merged, tests green on Linux CI (and on the platform in scope), docs/STATE updated, no new lint/brand/license violations, upstream-footprint budget still met.

### 1.5 Orchestration: one orchestrator, many locked workers
- **Roles.** Exactly one **orchestrator** (the main agent) owns planning, task assignment, integration, testing and feedback. **Worker** subagents execute implementation. Workers never assign, reassign, merge, or review each other's work.
- **One task, one agent, one branch.** A worker claims a task only via the lock protocol below, works exclusively on branch `agent/<task-id>-<short-slug>` cut from current `main`, and touches only that task's files (task tables list them; lanes in §1.3 bound the directories). A second worker on the same task or branch is forbidden.
- **Lock protocol (tracked in `docs/astra/STATE.md`).**
  1. Orchestrator marks the task `doing`, writes the worker's name in the Agent column and the branch name in the Branch column, and commits that row **before** the worker starts.
  2. The worker rebases onto `main` at start; if the task's files changed under it, it stops and reports instead of forcing through.
  3. While `doing`, no other agent may edit the task's rows, files, or branch. Questions go to the orchestrator, never to a side edit.
  4. Worker finishes by pushing its branch and reporting tests + diff summary. Only the orchestrator verifies (rebuilds/tests the acceptance criteria), merges to `main`, marks `done`, and commits the STATE row.
- **Conflict-free by construction.** Task tables declare non-overlapping file scopes; the orchestrator refuses to unlock two `doing` tasks whose scopes intersect. Shared files (`STATE.md`, `DECISIONS.md`, `branding/*`) are orchestrator-only edits.
- **Feedback loop.** The orchestrator runs the acceptance tests itself (or in CI), writes failures back to the task's Notes field in STATE.md, and re-locks the same task to the same worker for fixes. No new task starts on broken `main`.

---

## 2. Decisions register (initial)

| ID | Decision | Notes |
|---|---|---|
| D-01 | Engine = Gecko from **Firefox ESR**; start on **ESR 153** | Next ESR 175 planned 2027-06-29; one big jump per year, point releases in between |
| D-02 | Repo model = **pinned upstream + patch series + overlay**, assembled by `astra-forge` | Not a long-lived fork or merge-based fork |
| D-03 | Visible UI is **100% Astra (Svelte)**; Firefox chrome hidden first, pruned later | "Hide first, delete later" — much of Firefox is wired to its main window internals |
| D-04 | Process model: **Gecko host** + **`astra-core`** Rust sidecar (child process); optional resident helper `astra-agent` for global hotkey/tray when browser is closed | Helper is Phase 8 |
| D-05 | **State ownership:** Firefox owns *live* tab objects; `astra-core` owns *organisation* (spaces, folders, pins, order), history, sessions, settings, tasks, notes, agents | Reconciliation protocol in §5.4 |
| D-06 | IPC = length-prefixed JSON frames over **stdio pipes** (via Firefox's Subprocess facility) | UNVERIFIED U-01; fallback = authenticated loopback WebSocket with per-launch token. **No unauthenticated TCP, ever** |
| D-07 | Storage = **rusqlite** (bundled SQLite) + **rusqlite_migration**, WAL mode. Notes are Markdown files on disk, indexed in SQLite | Verified via Context7 |
| D-08 | Languages: Rust by default; Svelte/TS for UI; JS only for Gecko chrome glue (`.sys.mjs`) and Bun tooling/servers; C++ only inside tiny hook patches | |
| D-09 | **Bun** = package manager, workspaces, script runner, TS test runner; `bun.lock` committed; CI uses `bun ci` (frozen lockfile). Vite + Svelte plugin run under Bun | Verified via Context7 |
| D-10 | Ad/tracker blocker = **adblock-rust** (EasyList/EasyPrivacy seed) as an in-process Gecko Rust component hooked into the network layer | Needs `mach vendor rust` + `cargo vet`; fallback = local filtering proxy in `astra-core` |
| D-11 | Extensions = Firefox **WebExtensions**; curated "verified" gallery replaces Chrome Web Store install | Parity exception X-01 |
| D-12 | Spaces/profiles isolation = Firefox **containers** (contextual identities) + per-profile directories | Spike S-02 decides exact mapping |
| D-13 | Accounts/sync = **optional**, local-first, end-to-end encrypted, Rust server behind a `Store` trait | Phase 7 |
| D-14 | User-Agent keeps the standard Firefox-compatible token for site compatibility; Astra branding everywhere else | |
| D-15 | **No telemetry, no experiments, no Mozilla services** except an explicit allow-list from the endpoint audit (P1-T07) | |
| D-16 | Updates = Firefox's built-in updater pointed at **Astra's own update server** | Balrog-compatible or static manifests; see §6.6 |
| D-17 | Lint/format: keep Astra's `rustfmt.toml`, `deny.toml`, `rust-toolchain.toml` conventions; for TS use the linter Astra already uses, else Biome | |
| D-18 | Astra source licensed **MPL-2.0** (same as Astra and Firefox); every file has the MPL header | See §3 |
| D-19 | All names/IDs come from one file: `branding/astra.toml` | Placeholders for owner-supplied values (§3.3) |
| D-20 | Linux packaging order: tarball → AppImage → `.deb`; Flatpak/rpm after GA | |

---

## 3. Provenance, license and rebrand rules

### 3.1 What is allowed and what is required
- Astra is **MPL-2.0**; per its README, **the Astra name and logo are not licensed**. Astra may reuse Astra's code (modified or not) under MPL-2.0 and must **remove the Astra name, logo and branded assets**.
- **Required, non-negotiable (this is license compliance, not a "watermark"):**
  - Keep MPL-2.0 file headers and existing copyright notices in any file derived from Astra.
  - Ship `LICENSE` (MPL-2.0) and a `NOTICE` that credits derived portions ("Portions derived from Astra, MPL-2.0") plus third-party notices.
  - Keep EasyList/EasyPrivacy attribution (CC BY-SA 3.0) per Astra's `assets/blocker-seed/v1/NOTICE`.
  - Keep notices for other dependencies (Tauri/Wry if any remain, adblock-rust, etc.). Use `cargo-about`/`cargo deny` for Rust and an equivalent license check for Bun packages.
  - Modified MPL files stay MPL and their source must remain available.
- The above is engineering guidance, **not legal advice**; the owner should have the final license/trademark review done before public distribution.
- Firefox side: do not ship Mozilla's name/logos. Use custom branding (`MOZ_BRANDING_DIRECTORY`-style directory, e.g. `astra/branding/`). The `Firefox` token may remain only in the compatible UA string and in required legal notices.

### 3.2 Rename scheme (automated, then reviewed) — completed: all previous product-name variants now read `Astra`
| From (previous product name) | To |
|---|---|
| Previous name, Title Case | `Astra` |
| Previous name, lowercase | `astra` |
| Previous name, UPPER CASE | `ASTRA` |
| Crate names `<prev>-*` | `astra-*` |
| Env vars/prefs `<PREV>_*`, `<prev>.*` | `ASTRA_*`, `astra.*` |
| Dev profile id `app.<prev>.dev` | value from `branding/astra.toml` (dev suffix) |
| Astra URLs (site, GitHub, Discord, YouTube, update, docs) | **remove or replace with owner-provided Astra URLs**; never leave dangling Astra links |
| Logo, icons, screenshots, illustrations, fonts specific to Astra | **replace with Astra assets** (owner supplies; agents may generate neutral placeholders clearly marked `PLACEHOLDER`) |

Implementation: `tools/rebrand` (Rust, in `forge/` or `xtask`) with a dry-run mode that outputs a diff report; rename file/dir names *and* contents; handles case variants; skips the allow-list below.

### 3.3 Branding source of truth: `branding/astra.toml`
Fields: `display_name`, `binary_name` (`astra`), `app_id` (reverse-DNS, **owner decision**), `vendor`, `homepage`, `update_host`, `support_url`, `profile_dir_names` (per OS), `ua_token`, `icons` paths. Anything the owner has not provided is marked `OWNER_DECISION` and blocks release builds only (dev builds use clearly-marked dev defaults).

### 3.4 Brand-lint (CI gate, from Phase 0)
Fail CI if the previous product name (any case variant) appears in the repo **or in built artifacts** except in: `LICENSE`, `NOTICE`, `docs/astra/PROVENANCE.md`, and MPL file headers/copyright lines of derived files. Also scan built artifacts (binary strings, bundled JS, resources) after packaging.

---

## 4. Research grounding

### 4.1 Verified facts (retrieved 2026-11-01)
| # | Fact | Source |
|---|---|---|
| F-01 | Astra is a Rust + Tauri/Wry app with a Svelte UI; pages run in raw native webviews (WebKit on macOS, WebView2 on Windows); a Rust core owns tabs, storage, blocker, extensions and agents; MPL-2.0; name/logo not licensed; Linux not supported | https://github.com/astra-browser/Astra |
| F-02 | Astra's blocker is Brave's `adblock-rust` with EasyList/EasyPrivacy; Chrome extensions install from the Chrome Web Store (20 verified); imports from Chrome, Safari, Arc, Zen, Firefox, Brave, Edge; "Work" mode with 25 skills, MCP servers, BYO models, keys in OS keychain | same |
| F-03 | Firefox source of truth is Git: `https://github.com/mozilla-firefox/firefox`; branches `main`, `beta`, `release`, `esr*` | Mozilla "Firefox Git Migration" docs (2025) |
| F-04 | Current ESR is **153** (released 2026-07-21); ESR 140 EOL 2026-09-29; next ESR **175** planned 2027-06-29; rapid release moved to a **two-week** cadence from Firefox 155 | whattrainisitnow.com/calendar, The Register (2026-07-17), endoflife.ai |
| F-05 | Firefox forks disable Mozilla services at build time via `mozconfig`/`moz.configure` options: `MOZ_TELEMETRY_REPORTING=` (empty), `MOZ_DATA_REPORTING`, `MOZ_NORMANDY=False`, `MOZ_SERVICES_HEALTHREPORT=False`, `--disable-updater`, `--disable-crashreporter`, `--disable-parental-controls`, `--disable-backgroundtasks`, `--disable-legacy-profile-creation`, `--enable-geckodriver`; custom branding via `MOZ_BRANDING_DIRECTORY` | Tor Browser / Mullvad Browser commits on gitlab.torproject.org |
| F-06 | Zen Browser = curated patch set applied to a pinned Firefox via its tool **Surfer** (`surfer.json` pins the Firefox version; "Sync upstream Firefox to version X" commits); features implemented as JSWindowActors and XPCOM components; Surfer is MPL-2.0 and self-described as prototype-stage | github.com/zen-browser/desktop, npmjs.com/package/@zen-browser/surfer |
| F-07 | A Firefox fork can run its own updater backend: Ghostery's browser runs a **Balrog** update server and sets `MOZ_APPUPDATE_HOST` at build time; Firefox's update uses **MAR** files, with Mozilla's docs describing the update driver and update binary | Ghostery `user-agent-desktop` docs; firefox-source-docs update implementation |
| F-08 | Rust can be added to Firefox: crates link into libxul via the `gkrust` setup, new dependencies need `mach vendor rust` and `cargo vet` audits; XPCOM components can be written in Rust using the `xpcom` crate and `#[xpcom]` macro | firefox-source-docs "Including Rust Code in Firefox", searchfox `xpcom/rust` |
| F-09 | WebDriver BiDi in Firefox provides `browsingContext`, `script`, `network` (incl. interception), `input`, `storage`, `permissions`, `webExtension` modules; CDP is deprecated/removed | MDN WebDriver BiDi modules; fxdx.dev |
| F-10 | Firefox now ships native **Split View** (149+, improved in 150), vertical tabs and tab groups | Firefox Nightly News, alternativeto (Firefox 150), Firefox 157 "Nova" coverage |
| F-11 | `rusqlite_migration` applies schema migrations atomically via `Migrations::to_latest` (uses SQLite `user_version`); WAL via `pragma_update_and_check` | Context7 `/websites/rs_rusqlite_migration` |
| F-12 | `bun ci` ≡ `bun install --frozen-lockfile`; requires committed `bun.lock`; workspaces via `"workspaces"` in `package.json` | Context7 `/oven-sh/bun` |

### 4.2 Reference projects to study (do not copy blindly; respect licenses)
Zen Browser + Surfer (patch-set model), Tor Browser / Mullvad Browser (ESR patch stacks, strict build flags), Ghostery user-agent-desktop (own Balrog), Floorp, LibreWolf.

### 4.3 UNVERIFIED assumptions — each has a Phase 0/1 spike
| ID | Assumption | Spike | Fallback |
|---|---|---|---|
| U-01 | Chrome JS can spawn the sidecar and exchange binary-safe frames over stdio using Firefox's Subprocess module on all 3 OSes | P1-T09 | Loopback WebSocket with random port + per-launch token, bound to 127.0.0.1 only |
| U-02 | After one full build, `./mach build faster` rebuilds frontend-only (JS/CSS/XHTML) changes quickly, and works with a tarball-sourced engine dir | P1-T04 | Keep engine as a local git repo; full incremental builds |
| U-03 | `mach` artifact builds work for the pinned ESR when the engine is a shallow git checkout of the official repo | P1-T04 | Skip artifact builds; use `build faster` |
| U-04 | Svelte output (no `eval`, no inline script) loads fine as chrome-privileged ES modules under Firefox's chrome CSP via `chrome://astra/` / `resource://astra/` | P1-T08 | Pre-compile to plain JS/CSS bundles with a custom Vite config |
| U-05 | `<browser>` elements of the tabbrowser can be positioned by CSS into Astra's content slot (and multiple at once for split/Work panes) without reparenting | S-01 (P3-T02) | Use Firefox's split-view wrapper primitives; or minimal patch to tabpanels |
| U-06 | Firefox's history DB (Places) must stay populated to keep `:visited` link styling, fed by `astra-core` | P2-T07 | Disable `:visited` styling or accept loss |
| U-07 | Firefox containers (contextual identities) can model Astra spaces/profiles with isolated cookies/storage | S-02 (P3-T07) | Separate profile directories per Astra profile |
| U-08 | Global hotkey on Linux works on X11 via a Rust crate; on Wayland needs the GlobalShortcuts desktop portal (compositor support varies) | P8-T05 | Show in-app hotkey only on unsupported compositors; document |
| U-09 | Windows: Mozilla Maintenance Service needs a Mozilla-signed updater unless reconfigured; forks either disable it or provide their own certificate chain | P9-T06 | Per-user install with in-place updates without the service |
| U-10 | `archive.mozilla.org` source tarballs and checksums/signatures exist for the pinned ESR with the expected URL layout | P1-T01 | Shallow git clone of official repo by tag/branch |
| U-11 | An out-of-tree Astra directory can be wired into the Firefox build with a few lines of `moz.build`/`jar.mn` hooks | P1-T05 | Copy overlay into tree during `forge overlay` |
| U-12 | Astra's Rust core can be separated from Tauri/Wry with a narrow trait at the adapter seam | P0-T04 | Rewrite adapters; core logic is still reusable |
| U-13 | Mica-like effects on Windows 11 are available via Firefox settings; Liquid Glass on macOS 26 needs widget-layer patches | P9-T07, P10-T06 | Solid/translucent fallback themes |

---

## 5. Architecture

### 5.1 Layers
```
┌──────────────────────────── Astra window (one Gecko chrome window) ───────────────────────────┐
│  Astra UI (Svelte, chrome-privileged)  ← only visible chrome                                    │
│    sidebar · tabs · spaces · launcher · Work canvas · tasks · notes · time · settings           │
│    ┌──────────── content slot(s): Firefox <browser> elements placed by CSS ───────────┐        │
│    │               web pages (content processes, Fission, sandbox)                    │        │
│    └─────────────────────────────────────────────────────────────────────────────────┘        │
│  Host API (resource://astra/host/*.sys.mjs, versioned)  ← the ONLY code touching Firefox internals│
└───────────────┬──────────────────────────────────────────────────────────────────────────────┘
                │ stdio frames (JSON) — D-06
        ┌───────▼────────┐   in-process Rust component (XPCOM): blocker hook (D-10)
        │  astra-core     │──────────────────────────────────────────────────────────────┐
        │  (Rust sidecar) │  SQLite · tasks · notes · time · blocker lists · agents ·    │
        └───────┬────────┘  MCP · models · keychain · sync client · importers            │
                │ HTTPS (opt-in)                                                         │
        ┌───────▼────────┐                                                      ┌───────▼───────┐
        │ Astra Cloud     │ accounts · E2EE sync (Rust)                          │ Gecko engine   │
        └────────────────┘                                                      └───────────────┘
```

### 5.2 Repository layout (monorepo `astra/`)
```
astra/
├─ branding/astra.toml              # single source of names/IDs (D-19)
├─ upstream.toml                    # pinned Firefox version, checksums, source URL
├─ patches/                         # ordered upstream patch series (see §6.3)
├─ overlay/                         # files copied/linked into the Firefox tree
│   ├─ astra/host/                  # Host API (.sys.mjs), actors, schemas
│   ├─ astra/chrome/                # shell loader, content-slot CSS, jar.mn, moz.build
│   ├─ astra/branding/              # icons, branding dir
│   ├─ astra/policies/              # distribution/policies.json
│   └─ astra/prefs/                 # pref overrides (config before patches!)
├─ config/mozconfig.{linux,windows,macos}   # build options (F-05 flags)
├─ crates/
│   ├─ astra-core/                  # sidecar binary
│   ├─ astra-proto/                 # IPC types, generated from schemas (shared with TS)
│   ├─ astra-store/                 # rusqlite + migrations
│   ├─ astra-blocker/               # adblock-rust wrapper; also built as Gecko component crate
│   ├─ astra-agents/                # Work: agent runtime, skills, MCP, models
│   ├─ astra-sync/                  # sync client + crypto
│   ├─ astra-import/                # browser importers
│   └─ astra-host-trait/            # `BrowserHost` trait (replaces Wry adapters)
├─ ui/                              # Bun workspace: Svelte app, @astra/bridge, @astra/host-types
├─ servers/                         # Rust: astra-cloud (accounts+sync), astra-update (optional); Bun: site/docs
├─ forge/                           # `astra-forge` (Rust xtask-style CLI) — fetch/import/overlay/build/package/bump
├─ tools/                           # rebrand, brand-lint, golden-capture, parity-report
├─ tests/                           # e2e (Marionette/BiDi), contract, golden screenshots, eval/agentic-browsing
├─ docs/astra/                      # state, decisions, parity, runbooks
└─ .github/workflows/
```
The Firefox source itself is **not** committed; `forge fetch` materialises it into `engine/` (git-ignored).

### 5.3 Technology stack
| Concern | Choice |
|---|---|
| Browser engine | Gecko (Firefox ESR, pinned) |
| Build orchestration | `astra-forge` (Rust CLI) wrapping Firefox's `mach` |
| Core services | Rust (tokio async), `serde`, structured logging (`tracing`) |
| Storage | `rusqlite` (bundled SQLite) + `rusqlite_migration`; WAL |
| Blocker | `adblock-rust` + EasyList/EasyPrivacy seed |
| UI | Svelte (same major as Astra) + Vite, run under Bun; CSS as in Astra |
| UI↔core bridge | `@astra/bridge` (TS) ↔ Host API ↔ stdio frames ↔ `astra-core` |
| Package manager / scripts / TS tests | **Bun** (`bun ci`, workspaces, `bun test`) |
| JS servers (site, docs, small services) | Bun runtime + TypeScript |
| Heavy servers (accounts/sync/update) | Rust (axum-style stack; choose via Context7), SQLite via rusqlite behind a `Store` trait |
| Crypto | RustCrypto (Argon2id KDF, XChaCha20-Poly1305 AEAD); WebAuthn/passkeys via a maintained Rust crate |
| Keychain | OS keychain via a maintained Rust crate (Secret Service on Linux, Credential Manager, Keychain) |
| Global hotkey | maintained Rust crate; Wayland via portal (U-08) |
| Agent control of pages | WebDriver BiDi first; custom content actor (JSWindowActor) later for DOM/a11y snapshots |
| Tests (Rust) | `cargo nextest`, `proptest`, `insta` snapshots |
| Tests (TS/UI) | `bun test`, Svelte component tests, Playwright-style *golden screenshots* of the standalone UI |
| Tests (browser) | Firefox in-tree harnesses (xpcshell/browser-chrome) + geckodriver (Marionette chrome context / BiDi) for E2E |
| Supply chain | `cargo deny`, `cargo audit`, `cargo vet` (in-tree crates), `bun audit`, SBOM (CycloneDX) |
| CI/CD | GitHub Actions (+ self-hosted/large Linux runner for engine builds), `sccache`/`ccache` |
| Packaging | Linux: tarball, AppImage, `.deb`; Windows: installer + MAR; macOS: `.app`/`.dmg` + MAR |

### 5.4 State ownership and reconciliation (D-05)
- **Firefox host** owns live objects: windows, `<browser>` elements, navigation state, process lifetimes, downloads, permissions prompts.
- **`astra-core`** owns *organisation and data*: space/folder/pin assignment, display order, titles, history, session snapshots, favicons cache index, settings, keybindings, tasks, notes, time, agents, sync.
- **Protocol:** commands flow UI → core → Host API (e.g. `tab.create`); events flow Host API → core (`tab.created`, `tab.updated`, `tab.closed`, `nav.committed`) → UI. Core assigns a stable `astra_tab_id` ↔ Firefox `linkedPanel`/browser id mapping. On startup the core **replays** its session snapshot through the Host API; on conflict, Firefox's live state wins for existence, core's state wins for organisation.
- All Host API calls are idempotent and carry a `request_id`; the host emits a monotonically increasing `event_seq` so core can detect gaps and resync.

### 5.5 Security model (carry over Astra's, extend)
- Untrusted pages never share a process or privilege with Astra UI (Gecko content processes; chrome UI is bundled, no remote code).
- Astra UI loads **only bundled** modules from `chrome://astra/` / `resource://astra/`.
- Sidecar IPC is private to the parent process (pipes) or token-authenticated loopback (fallback).
- Agent safety: page content is **untrusted data**; side-effect actions (post, merge, send, delete, run command) require explicit user approval enforced in `astra-core`, not in UI.
- Secrets (API keys) only in OS keychain; never in SQLite, logs, or sync payloads unencrypted.
- No telemetry (D-15). Endpoint audit gate in CI (§9.3).

---

## 6. The Forge: making Firefox upgrades boring

**Goal:** moving to a new Firefox version is *change one value, run one command, read one report*. This section is the answer to "make updates easy."

### 6.1 Principles
1. **Never merge, always re-apply.** Astra = pinned upstream + patch series + overlay. A new Firefox version means re-applying patches to a fresh source tree, not merging history.
2. **Config before code.** Prefer build flags, `policies.json`, pref overrides and branding directory over patches.
3. **Overlay before patch.** New Astra code lives in `overlay/astra/` (own directory, own `moz.build`/`jar.mn`); upstream files are touched only by tiny hooks.
4. **One seam.** All Astra code reaches Firefox internals only through the **Host API** (§6.4). Svelte UI and Rust core never call Firefox internals directly.
5. **Measure the footprint.** CI tracks total upstream lines touched and number of patches; budgets fail the build (§6.7).
6. **Test on every bump.** A bump is "green" only if contract tests, smoke E2E and golden screenshots pass.
7. **Stay on ESR.** One major jump per year (153 → 175) as a planned project, plus fast automated point updates (every ~2 weeks, security).

### 6.2 `upstream.toml` and `astra-forge` commands
`upstream.toml` fields: `channel` (`esr`), `version` (e.g. the pinned ESR point release), `source` (`tarball` | `git`), `url`, `sha256`, `signature_url` (if available), `git_ref` (if git), `release_notes_url`, `last_verified`.

| Command | Behaviour |
|---|---|
| `forge fetch` | Download/verify source for `upstream.toml`, extract to `engine/`, `git init` + baseline commit so patches are real diffs |
| `forge import` | Apply `patches/*` in order with 3-way apply; write a per-patch result (`clean` / `offset` / `fuzz` / `conflict`) to `docs/astra/UPSTREAM.md` and `out/patch-health.json` |
| `forge overlay` | Copy/link `overlay/astra/**` and branding into `engine/`; inject hooks list |
| `forge config` | Render `mozconfig` for the target OS from `config/` + `branding/astra.toml` |
| `forge build` | `mach build` (full) or `mach build faster` (frontend-only); sccache enabled |
| `forge test` | Run contract/smoke suites against the built binary |
| `forge package` | Produce platform artifacts + MAR/updater manifests |
| `forge export` | Turn commits in `engine/` back into numbered patch files with headers |
| `forge bump <version>` | Update `upstream.toml`, fetch, import, overlay, build, test, then write the upgrade report (§6.5) |
| `forge doctor` | Check toolchains, disk/RAM, mozconfig sanity, vendor/lock consistency |

Implementation notes: Rust CLI; may borrow ideas from Surfer (F-06) but does **not** depend on a prototype-stage Node tool. Download URLs/checksums must be verified at implementation time (U-10), never guessed.

### 6.3 Patch taxonomy and header
| Tier | Description | Rules |
|---|---|---|
| **P0 Config** | mozconfig flags, `policies.json`, pref overrides, branding dir | Preferred; zero upstream edits |
| **P1 Overlay** | New files under `overlay/astra/` (host API, actors, UI loader, CSS, Rust crates) | Free to add; must go through Host API contract |
| **P2 Hook** | ≤ 15 changed lines in an upstream file (e.g. mount point in the browser window, `moz.build` include) | One concern per patch |
| **P3 Structural** | Larger edits (e.g. native window effects, removing a subsystem) | Needs written justification in `DECISIONS.md` + owner approval + dedicated tests |

Patch file header (mandatory, parsed by tooling):
```
Patch-Id: ASTRA-0007
Title: Mount Astra shell root in the main browser window
Tier: P2
Upstream-Files: browser/base/content/browser.xhtml
Intent: <why this cannot be done by config/overlay>
Risk: low|medium|high   (what breaks if upstream changes this area)
Test: tests/contract/shell_mount.test.*
Verified-On: <ESR version>
Removal-Plan: <what would let us delete this patch>
```
Patches are numbered, ordered, small, independent where possible, and never mix refactors with behaviour.

### 6.4 The Host API (the one seam)
Location: `overlay/astra/host/` (`.sys.mjs` modules), JSON-schema'd and versioned (`HOST_API_VERSION`). TypeScript types and Rust types are **generated from the same schemas** (`astra-proto`).

| Module | Responsibility |
|---|---|
| `Windows` | create/close/focus windows, custom titlebar region, fullscreen, private windows |
| `Tabs` | create/close/select/move/duplicate/discard-sleep tabs; mapping `astra_tab_id` ↔ browser |
| `Navigation` | load URL, back/forward/reload/stop, find-in-page, zoom, print, reader/readability extraction |
| `Panes` | place one or more content browsers into UI slots (split view, Work canvas panes) |
| `Containers` | create/delete isolated contexts for spaces/profiles/agent sessions |
| `Content` | JSWindowActor bridge: DOM/a11y snapshots, element hiding, selection, scrolling, screenshots |
| `Net` | blocker hook registration, request metadata, proxy settings |
| `Downloads`, `Permissions`, `Certs` | thin wrappers delivering events/prompts to Astra UI |
| `Extensions` | install/enable/disable WebExtensions, gallery metadata, permission prompts |
| `Session` | snapshot/restore data in a form `astra-core` stores |
| `Native` | tray/launcher window, global shortcuts (via core helper), notifications, OS theme/effects |
| `Boot` | startup/shutdown handshake with `astra-core`, version negotiation |

Rules: no Astra module outside `host/` may import Firefox internals (`Services`, `gBrowser`, `ChromeUtils.*`, XPCOM) — a lint rule enforces it. Every Host API function has a **contract test** that runs in a real Astra build. Breaking changes require bumping `HOST_API_VERSION` and updating the generated types.

### 6.5 Bump workflow and upgrade report
**Automatic (point releases, e.g. 153.x → 153.y):**
1. Scheduled workflow polls upstream release data (verified source) for a newer ESR point release.
2. Opens a PR that changes only `upstream.toml`.
3. CI runs `forge bump` → `import` → build → contract + smoke + golden tests.
4. Green → auto-merge into `release-candidate`; owner approval gate before public release (§10.4).
5. Red → issue with `patch-health.json`, failing tests, and the upstream files changed since the last verified version that intersect Astra's patched files (the **upstream-change radar**).

**Planned (ESR jump, e.g. 153 → 175):** a scheduled project starting when the next ESR reaches Beta. Steps: radar report → fix Host API modules first → re-apply patches (agents resolve conflicts one patch at a time, tests as guardrail) → rebuild → full parity suite → soak on a canary channel → release before the old ESR's end of life (Mozilla keeps the old ESR alive for roughly ten weeks after the new one ships; confirm the dates each cycle).

**Upgrade report (`docs/astra/UPSTREAM.md`)** contains: versions (from → to), per-patch status table, tests summary, files that changed upstream within Astra's touch-points, new Mozilla endpoints detected (endpoint audit diff), new prefs/telemetry defaults detected, and action items.

### 6.6 Shipping updates to users
- Use Firefox's built-in updater (MAR-based; docs in firefox-source-docs update implementation) with Astra's own update host (`MOZ_APPUPDATE_HOST`-style build setting, per Ghostery's precedent F-07). Update host comes from `branding/astra.toml`.
- **Start simple:** static, signed update manifests + MAR files on a static host; move to a Balrog instance only if channel/rule complexity demands it.
- **Channels:** `nightly` (CI), `beta`, `release`. Same binaries promoted, never rebuilt.
- **Partial MARs** generated from the previous release to keep downloads small.
- **Signing:** Linux (checksums + detached signatures for tarball/AppImage/deb repo metadata), Windows (Authenticode), macOS (Developer ID + notarisation). Certificates are owner-provided.
- **Security SLA target:** ship a rebuilt point release within **72 hours** of each upstream security release. If the pipeline cannot meet this, the build is not publicly distributed.
- **Rollback:** previous version stays available on the channel; a "pause" switch on the update server halts a bad rollout.

### 6.7 Footprint budgets (CI-enforced)
| Metric | Budget (initial) |
|---|---|
| Total upstream lines touched by P2/P3 patches | ≤ 1,500 (alert at 1,000) |
| Number of patches | ≤ 60 |
| P3 patches | ≤ 8, each with owner sign-off |
| Files outside `overlay/astra/` modified | tracked and listed; growth requires justification |
| Patch conflicts on a point-release bump | target 0; > 2 raises an alert |

---

## 7. Feature parity matrix (source of truth: Astra; verified against its code in Phase 0)

> Agents: P0-T03 expands this table to **every** command, screen, setting and shortcut found in Astra's source and generates `docs/astra/PARITY.md`. Features below are from Astra's README; code may reveal more. If code and README disagree, **code wins**.

| Area | Astra feature | Astra implementation | Phase |
|---|---|---|---|
| Shell | Vertical tab sidebar, quiet design, spaces, profiles, pinned tabs, folders, split view | Astra Svelte UI; tabs are Firefox `<browser>` elements in content slots; spaces/profiles via containers (D-12) | 3 |
| Shell | Liquid Glass (macOS 26) / Mica (Windows 11) | Native effects via widget work (parity exception X-02) | 9–10 |
| Shell | Launcher (⌘⇧Space / Ctrl+Shift+Space) reaching tabs, history, notes, commands; anything typed can become a task | Launcher window driven by core; global hotkey helper | 8 |
| Shell | Rebindable keyboard shortcuts | Core-owned keymap; Host API key routing | 3 |
| Browse | Inactive tabs sleep and wake | Firefox tab discard/unload via `Tabs.discard`, policy in core | 4 |
| Browse | Native ad/tracker blocker (adblock-rust, EasyList/EasyPrivacy), click-to-hide elements | In-process blocker component + `Content` actor for element hiding | 4 |
| Browse | Extensions: Chrome Web Store install, 20 verified | WebExtensions + curated gallery (X-01) | 4 |
| Browse | Import from Chrome, Safari, Arc, Zen, Firefox, Brave, Edge; welcome flow | `astra-import` crate + onboarding UI (Firefox migrators may be reused where helpful) | 4 |
| Browse | Private windows keep nothing | Firefox private browsing + core purge guarantees | 4 |
| Built-in | **Tasks:** natural-language entry ("call Anna tomorrow at 3"), lists, priorities, deadlines, subtasks, linked page | `astra-store` + parser (port from Astra) + UI | 5 |
| Built-in | **Time:** per-site time (on-device), focus timer, sites blocked until break | Tab-activity events → core; focus-mode blocking via `Net` hook | 5 |
| Built-in | **Notes:** Markdown files you own; external edits appear in app | Files on disk + watcher + index | 5 |
| Work | Describe outcome → canvas; steps visible; recalls memory; searches history; loads skills | `astra-agents` runtime + canvas UI | 6 |
| Work | Parallel helpers browsing live pages you can watch; sources open in side pane | Helper = agent session in its own container + visible `Panes` | 6 |
| Work | Results stay on canvas (tables, charts, diagrams, plans, code, documents); plan → tasks; save as note | Port canvas renderers | 6 |
| Work | Reads/edits granted folders, runs commands, hands jobs to Claude Code/Codex | Scoped FS + command runner with approval gates | 6 |
| Work | MCP servers (Linear, Notion, Sentry, Stripe, Figma), CLI tools (`gh`) | MCP client in core; per-server permissions | 6 |
| Work | Approval before anything that posts/merges/changes | Enforced in core | 6 |
| Work | BYO models: Anthropic, OpenAI, Gemini, DeepSeek, OpenRouter; local via Ollama/LM Studio/OpenAI-compatible; keys in OS keychain | Provider traits + keychain | 6 |
| Work | 25 bundled skills + user-defined skills | Port skills verbatim (minus branding) + loader | 6 |
| Privacy | No telemetry, no account needed; history/tasks/notes/memory/time on device | D-15 + optional accounts (D-13) | 1, 7 |
| Updates | Background download, "Relaunch to update" | Firefox updater + Astra update host | 8 |
| Quality | `eval/agentic-browsing` evaluation suite | Port as agent regression suite (`tests/eval/`) | 6 |

### 7.1 Parity exceptions register (honest deviations)
| ID | Astra behaviour | Astra behaviour | Mitigation |
|---|---|---|---|
| X-01 | Install extensions straight from Chrome Web Store | Not possible on Gecko | Curated gallery mapping Astra's 20 verified extensions to their Firefox/AMO equivalents; compatibility notes per extension |
| X-02 | Liquid Glass / Mica effects | Needs engine widget work | Phase 9–10; fallback translucent themes |
| X-03 | ~30 MB download | Larger (engine bundled; expect roughly 3× or more) | Document; partial MAR updates |
| X-04 | Page rendering via WebKit/WebView2 | Gecko everywhere | Expected benefit; site-compat tests |
| X-05 | No Linux build | Linux is Astra's first platform | New work: Wayland/X11, packaging, keychain via Secret Service |
| X-06 | Astra name/logo/art | Astra identity | Owner-supplied assets (§3) |

---

## 8. Phases

Sizing: **S** ≈ hours–1 day, **M** ≈ days, **L** ≈ 1–2 weeks, **XL** ≈ multi-week (for one focused agent/human). Each phase ends with an **exit gate**; do not start the next phase's dependent tasks before the gate unless marked parallel-safe.

```
P0 ──► P1 ──► P2 ──► P3 ──► P4 ──► P5 ──► P6 ══► Linux Parity Beta
                      ▲ P3 UI and P2 core can overlap after P2-T05
Linux Parity Beta ──► P7 (sync) ──► P8 (Linux GA) ──► P9 (Windows) ──► P10 (macOS) ──► P11 (exclusive features)
Parallel-safe: Lane D (tests/CI) from P0; Lane E (cloud) can start P7-T01/T02 after P2.
```

### Phase 0 — Discovery, inventory, scaffolding (size M)
**Goal:** know exactly what Astra is; set up the repo, rebrand tooling, provenance and CI before any porting.

| ID | Lane | Task | Deliverable / acceptance |
|---|---|---|---|
| P0-T01 | A | Machine and toolchain check for Linux: Rust (per Astra's `rust-toolchain.toml`), Bun, Firefox build prerequisites (`mach bootstrap`), disk/RAM budget | `forge doctor` skeleton passes; requirements recorded in `docs/astra/DEV_SETUP.md` (verify current Firefox build requirements from official docs) |
| P0-T02 | D | Create clean `astra` repo from the local Astra working copy (`/home/rem/Projects/Browser/Astra`); record the exact Astra base commit SHA | Single "import" commit; SHA in `PROVENANCE.md` so later diffs vs upstream are possible |
| P0-T03 | B,C | **Full inventory** using the existing graphify output + source: every Rust crate and its Tauri/Wry coupling; every Tauri command and event used by the UI; every screen/route/component; settings keys; shortcuts; SQLite or other storage schemas; assets; the 25 skills; the 20 verified extensions; `eval/agentic-browsing`; docs | `docs/astra/INVENTORY.md`, `docs/astra/ipc-surface.md`, generated `PARITY.md` (README claims vs code; code wins) |
| P0-T04 | B | Classify each Astra dir/crate as **KEEP / ADAPT / DROP** (`crates/`, `desktop/`, `frame/`, `patches/`, `vendor/`, `xtask/`, `eval/`, `assets/`); define the `BrowserHost` trait at the Wry/Tauri adapter seam (U-12) | `docs/astra/PORTING_MAP.md`; trait signature draft reviewed |
| P0-T05 | D | Rebrand tooling: `tools/rebrand` (dry-run + apply), `branding/astra.toml`, placeholder Astra assets, **brand-lint** (§3.4) | Dry-run diff report reviewed; brand-lint runs (report-only until P1 exit, then enforced) |
| P0-T06 | D | License/provenance: `LICENSE`, `NOTICE`, `PROVENANCE.md`; dependency license inventory (`cargo about`, Bun package license check) | Reviewed; CI job fails on unknown licenses |
| P0-T07 | D | **Golden capture harness:** run the (rebranded) Svelte UI standalone in a normal browser with mocked IPC to capture reference screenshots per screen/state/theme/viewport | `tests/golden/baseline/` (generated from Astra build only); original Astra screenshots stay local and git-ignored, used only to prove the rebrand changed text/logo regions and nothing else |
| P0-T08 | D | CI skeleton on the imported code: fmt, clippy, nextest, `cargo deny`, `bun ci`, typecheck, brand-lint (report) | Green on `main` |
| P0-T09 | all | Write spike briefs for every `U-xx` item in §4.3 | `docs/astra/spikes/*.md` with question, method, success criterion, fallback |
| P0-T10 | D | Repo hygiene: `STATE.md`, `DECISIONS.md`, `OWNER_QUESTIONS.md`, `SECURITY.md`, `CONTRIBUTING.md` (rewritten for Astra), `CODEOWNERS` | Files exist; no Astra branding |

**Exit gate P0:** owner reviews INVENTORY + PARITY + PORTING_MAP; rebrand dry-run clean; CI skeleton green.

### Phase 1 — Forge and skeleton on Linux: "Hello Tab" (size XL)
**Goal:** a rebranded, telemetry-free Firefox-based build on Linux whose window shows only Astra UI and one live web page.

| ID | Lane | Task | Deliverable / acceptance |
|---|---|---|---|
| P1-T01 | A | `upstream.toml` + `forge fetch`: verify source URL/checksum/signature scheme for the pinned ESR 153 point release (U-10) | Reproducible fetch; checksum verified; baseline git commit in `engine/` |
| P1-T02 | A | `forge config` + `config/mozconfig.linux` using the flags in F-05 (telemetry/data reporting/Normandy/health report off, parental controls off, background tasks off, legacy profile creation off, geckodriver on, custom branding dir). **Verify each flag name against the pinned source** | `forge doctor` validates flags exist; documented in `docs/astra/BUILD_FLAGS.md` |
| P1-T03 | A | Branding overlay: Astra branding directory, app name/vendor, icons, desktop file, about strings; UA decision (D-14) | Window title, `about:` pages and desktop entry show Astra; no Mozilla logos |
| P1-T04 | A | First full Linux build; measure time/disk/RAM; set up `sccache`; document the fast dev loop (`build faster`, U-02/U-03) | `docs/astra/BUILD_TIMES.md`; incremental UI-only rebuild measured |
| P1-T05 | A | Overlay wiring: register `chrome://astra/` and `resource://astra/`; hook list (U-11) → **ASTRA-0001** | Build includes overlay; patch header lint passes |
| P1-T06 | A | `policies.json` + pref overrides to disable telemetry/studies/Sync UI/Pocket/first-run pages/default-browser nags/New Tab services. **Verify policy and pref names from official docs** | Fresh profile shows no Mozilla promos; test asserts prefs |
| P1-T07 | D | **Endpoint audit tool**: launch fresh profile, idle 10 min, then scripted browsing; capture every outbound host; classify KEEP (security-critical) / REPLACE / REMOVE with owner sign-off | `docs/astra/ENDPOINTS.md`; CI gate: no unclassified hosts at idle |
| P1-T08 | A,C | Shell mount patch (**ASTRA-0002**): mount `#astra-root` in the main window; hide Firefox chrome with CSS; load a "hello" Svelte bundle as a chrome module (U-04) | Window shows only Astra hello UI |
| P1-T09 | B | Sidecar spike (U-01): spawn `astra-core` stub from chrome JS, exchange frames, measure latency/throughput, test crash/restart | Decision recorded: stdio vs WebSocket fallback |
| P1-T10 | A,C | Content slot: one live tab in the window; minimal URL bar drives navigation through Host API stub | Can load and interact with real sites; back/forward works |
| P1-T11 | D | Contract-test harness: geckodriver/Marionette (chrome context) boots Astra, checks branding, Host API version, loads a local fixture page | `forge test` runs in CI on Linux |
| P1-T12 | D | `forge export/import` round-trip test; patch header lint; footprint-budget job (§6.7) | CI green |

**Exit gate P1 (M1):** Linux build runs; window = Astra UI + a live tab; no unexpected network at idle; contract test, brand-lint (now enforced) and footprint jobs green; dev loop documented.

### Phase 2 — Core, storage and bridge (size XL)
**Goal:** `astra-core` runs as the sidecar and the UI can talk to it through a Tauri-compatible bridge.

| ID | Lane | Task | Deliverable / acceptance |
|---|---|---|---|
| P2-T01 | B | Bring over crates per PORTING_MAP; replace Tauri/Wry coupling with `BrowserHost` | `astra-core` builds without Tauri/Wry; unit tests pass |
| P2-T02 | B,C | `astra-proto`: schemas for all commands/events from `ipc-surface.md`; generate Rust + TS types; protocol versioning; JSON fixtures | Round-trip tests; CI fails if generated files drift |
| P2-T03 | B | IPC transport: framing, max sizes, backpressure, heartbeats, auth, crash recovery both directions | Chaos tests: kill core/browser at random points; state recovers |
| P2-T04 | B | `astra-store`: rusqlite (bundled) + rusqlite_migration, WAL, schemas ported/defined (Appendix B), backup/export, corruption recovery | Migration tests from every historical version; property tests |
| P2-T05 | B | `GeckoHost` (over Host API) and `MockHost` implementations of `BrowserHost` | Core integration tests run against `MockHost` (fast) and `GeckoHost` (E2E) |
| P2-T06 | A,B | Host API v1: `Boot`, `Windows`, `Tabs`, `Navigation` modules with schemas, events and `event_seq` | Contract tests for every function |
| P2-T07 | A,B | History mirror into Firefox's history store so `:visited` works (U-06) | Test: visited link color after navigation, cleared after history clear |
| P2-T08 | C | `@astra/bridge`: implements the Tauri `invoke`/`listen`/window API surface used by the UI, over Host API + IPC; plus standalone **mock mode** | UI runs both in Firefox and standalone (for goldens/dev) |
| P2-T09 | B | Session snapshot/restore round-trip (tabs, spaces, folders, scroll, per-tab state) | Kill -9 browser → restore exact organisation |
| P2-T10 | B | Settings, keymap store, structured logging, local-only diagnostics bundle (no upload) | Diagnostics export works; no network calls |

**Exit gate P2:** with `MockHost` and real Host API, tabs/spaces data is created, persisted, and restored; kill tests pass; Host API v1 contract suite green.

### Phase 3 — UI port, 1:1 (size XL)
**Goal:** Astra's UI inside Firefox, visually and behaviourally matching, with Astra branding only.

| ID | Lane | Task | Deliverable / acceptance |
|---|---|---|---|
| P3-T01 | C | Move Svelte app into `ui/` Bun workspace; Vite config; `bun ci`; rebrand applied; chrome-constraint build (U-04) | `bun run build` produces bundles loaded by overlay |
| P3-T02 | A,C | **Spike S-01 content slots:** place one and many `<browser>` elements by CSS; resize; focus; devtools; verify split/Work panes (U-05) | `docs/astra/spikes/S-01.md` decision; prototype demo |
| P3-T03 | C,A | Window frame per OS (Linux first): custom titlebar/drag regions/window controls, sidebar, toolbar | Works on X11 and Wayland; WM edge cases documented |
| P3-T04 | C | Tabs: vertical list, pinned, drag-reorder, folders, context menus, favicons, audio/mute indicators, sleeping state | Golden + interaction tests |
| P3-T05 | B,C | **Spike S-02 + implementation of spaces/profiles** on containers/profile dirs (U-07) | Isolation test: cookies/localStorage not shared across spaces/profiles |
| P3-T06 | C,A | Split view and layout persistence using S-01 result | Create/resize/swap splits; survives restart |
| P3-T07 | B,C | Omnibox and search: suggestions from tabs/history/notes; default search engines configured locally (copy Astra's list; no Mozilla remote-settings dependency) | Typing latency budget met; search engines editable |
| P3-T08 | C | Settings UI, shortcut editor, theming (light/dark/auto), animation parity | Golden coverage of all settings pages |
| P3-T09 | A,C | Browser dialogs via Host API events: permissions, downloads UI, find-in-page, print, certificate error pages, HTTP auth, page context menus | **Security review:** cert errors and permission prompts cannot be spoofed by content |
| P3-T10 | C | Welcome/onboarding flow (import step stubbed until P4) | Golden + e2e |
| P3-T11 | D | Golden suite: Astra-in-Firefox vs standalone baseline; thresholds per screen | CI job; initial limit ≤ 1.5% pixel difference per screen (tune with owner) |
| P3-T12 | C,D | Accessibility pass: keyboard-only flows, screen-reader labels/landmarks, high-contrast, reduced motion | Checklist in `docs/astra/A11Y.md` complete |

**Exit gate P3 ("daily-driver browsing"):** owner can browse all day with tabs, spaces, split view, find, downloads; golden suite green; a11y checklist done.

### Phase 4 — Browse core: blocker, extensions, import, privacy (size XL)
| ID | Lane | Task | Deliverable / acceptance |
|---|---|---|---|
| P4-T01 | B | `astra-blocker` crate on adblock-rust; seed lists with attribution; list update mechanism; per-site toggles; filter fixture tests | Matches Astra's blocked-request behaviour on a fixture corpus |
| P4-T02 | A,B | In-tree Rust component for the network hook: vendor deps (`mach vendor rust`), `cargo vet` audits/exemptions, gkrust wiring, XPCOM component (F-08); fallback proxy behind same interface | Block works before request leaves; p95 added latency within budget; fallback toggle tested |
| P4-T03 | A,C | Element hiding: cosmetic filters + click-to-hide via `Content` actor; per-site persistence | Works on iframes/Shadow DOM fixtures |
| P4-T04 | B,C | Extension manager UI + curated gallery (Astra's 20 → Firefox equivalents), permission prompts, enable/disable | Smoke install/run test per gallery extension where automatable; doc of unmapped ones (X-01) |
| P4-T05 | B | Importers: Chromium family, Firefox, Zen (+ Safari/Arc in P10): bookmarks, history, and whatever Astra imports (verify in code) | Fixture-based tests per source; no data leaves device |
| P4-T06 | B | Tab sleeping policy (idle timers, memory pressure, exclusions for audio/pinned/devtools) | Wake latency and memory savings benchmarked |
| P4-T07 | B,D | Private windows: nothing persisted by core (history, sessions, favicons, time) | Forensic test: inspect profile + core DB after closing |
| P4-T08 | C,A | Downloads manager parity; PDF viewing (Firefox's built-in viewer) integrated into UI | Golden + e2e |
| P4-T09 | A,B | Password/autofill decision: keep Firefox login manager surfaces, or rely on password-manager extensions as Astra does; record in DECISIONS | Decision + implementation + tests |
| P4-T10 | D | Performance baselines vs stock Firefox ESR and Astra (startup, RAM at 10/50 tabs, scrolling, tab-switch) | `docs/astra/PERF.md`; budgets enforced in CI nightly |

**Exit gate P4:** blocker parity corpus passes; gallery extensions verified; private-window test passes; perf budgets set.

### Phase 5 — Tasks, Notes, Time (size L)
| ID | Lane | Task | Deliverable / acceptance |
|---|---|---|---|
| P5-T01 | B | Tasks domain: lists, priorities, deadlines, subtasks, linked page; natural-language parser ported with Astra's test cases ("call Anna tomorrow at 3") | Parser tests include time zones/DST/locale edge cases |
| P5-T02 | C | Tasks UI + in-app command palette "make task" action | Golden + e2e |
| P5-T03 | B,C | Notes as Markdown files in a user-chosen folder; index; file watcher; external edits appear live; conflict policy; editor beside page | Test with external editor concurrent edits |
| P5-T04 | B,C | Time tracking from tab-activity events: per-site totals (device-only), focus timer, focus-mode site blocking until break (via `Net` hook) | Accuracy test with synthetic activity; blocking cannot be bypassed by simple URL tricks |
| P5-T05 | B | Export/import (JSON + Markdown), migration tests | Round-trip lossless |

**Exit gate P5:** parity rows for Tasks/Time/Notes green.

### Phase 6 — Work: agents, canvas, skills, MCP (size XL)
| ID | Lane | Task | Deliverable / acceptance |
|---|---|---|---|
| P6-T01 | B | Design doc from inventory: agent loop, planner, steps stream, helpers, memory, history search, skills, approvals; port to `astra-agents` | Reviewed doc; module skeletons compile |
| P6-T02 | B | Provider layer: Anthropic, OpenAI, Gemini, DeepSeek, OpenRouter, local (Ollama, LM Studio, OpenAI-compatible); streaming, tool calls, retries, local-only usage accounting; keys via OS keychain | Provider conformance tests with recorded fixtures + one live smoke per provider (opt-in) |
| P6-T03 | B,A | Tool layer: browser tools (open, read via readability/a11y snapshot, click, type, scroll, screenshot) through Host API `Content`/BiDi; scoped filesystem; command runner; MCP client; CLI wrappers (`gh`) | Each tool has schema + tests; MCP tested against a mock server |
| P6-T04 | B,D | **Approval gate engine:** classify side-effect actions; ask by default; audit log; prompt-injection test suite (pages instructing the agent to exfiltrate data or act) | Injection suite passes; no side effect without approval event |
| P6-T05 | B,C | Helpers (parallel sub-agents): own container per helper, visible `Panes`, source pane, cancel, budgets (time/tokens/steps) | 3 helpers in parallel demo; cancellation leaves no orphan tabs |
| P6-T06 | C | Canvas UI: tables, charts, diagrams, plans, code, documents; plan → tasks; save → notes | Golden + e2e |
| P6-T07 | B,C | Skills: port the 25 bundled skills (rebranded), user-skill format and loader | Skill load/validation tests; each skill has a smoke eval |
| P6-T08 | B,C | Memory and history recall with user controls to view/edit/delete | Deletion actually removes data (test the store) |
| P6-T09 | B | Hand-off to Claude Code / Codex (process spawn, scoped dirs, streamed output) | Mocked-binary tests |
| P6-T10 | D | Port `eval/agentic-browsing` to `tests/eval/` using deterministic local fixture sites; nightly runs with budget caps; baselines | Baseline scores recorded; regressions flagged |

**Exit gate P6 → Linux Parity Beta:** every `PARITY.md` row applicable to Linux is done or listed in the exceptions register; nightly channel dogfooded for ≥ 2 weeks with no data-loss bugs.

### Phase 7 — Accounts and Sync: Astra Cloud (size XL)
Astra-specific (Astra has no accounts). Local-first: the browser is fully functional without an account.

| ID | Lane | Task | Deliverable / acceptance |
|---|---|---|---|
| P7-T01 | E,B | Threat model + protocol spec: key hierarchy, device enrolment, recovery key, collections, ordering (hybrid logical clocks), conflict rules, rollback/replay defence | `docs/astra/SYNC_SPEC.md`; external crypto review checklist; **no release before review** |
| P7-T02 | E | `astra-cloud` (Rust): auth (passkeys + email fallback), devices, rate limits, `Store` trait with SQLite implementation (rusqlite), migrations, structured logs/metrics | Integration tests; swap-in test double for `Store` |
| P7-T03 | B | `astra-sync` client: Argon2id key derivation, XChaCha20-Poly1305 encryption, per-collection op-log, offline queue, resumable sync | Property tests: convergence under random op reordering/duplication |
| P7-T04 | B | Collections: settings, spaces/folders/pins organisation, open-tabs (opt-in), bookmarks, history (opt-in), tasks, notes (conflict copies), extension list, skills | Per-collection toggles; round-trip tests |
| P7-T05 | C | Sync UX: sign-in, device pairing, recovery key flow, status, "sync now", reset, delete account | Golden + e2e |
| P7-T06 | E | Ops: Dockerfile, health/readiness, backups/restore drill, deployment docs, load test | Restore drill documented; load test report |
| P7-T07 | D | Security tests: fuzz protocol parsers, malicious-server tests, replay/rollback attacks, secrets scanning | Suite in CI nightly |
| P7-T08 | E | Privacy: server stores ciphertext + minimal metadata; retention policy; account deletion removes data | Verified by test + doc |

**Exit gate P7:** two devices converge; server compromise test shows no plaintext; crypto review signed off.

### Phase 8 — Linux General Availability (size XL)
| ID | Lane | Task | Deliverable / acceptance |
|---|---|---|---|
| P8-T01 | A | Packaging: tarball, AppImage, `.deb`; desktop entry, MIME handlers, default-browser registration, icons; Wayland and X11 | Install/uninstall tests in clean containers/VMs |
| P8-T02 | A,E | Updater end-to-end: MAR generation, partial MARs, update host, channels, staged rollout, "Relaunch to update" UX | Update from N-1 → N tested in CI; rollback drill |
| P8-T03 | B | Resident helper `astra-agent`: tray, autostart, single instance, launches browser | Works with browser closed |
| P8-T04 | C,B | Launcher window: search tabs/history/notes/commands; "make task" from anything typed | Latency budget; golden |
| P8-T05 | B | Global hotkey: X11 via crate; Wayland via GlobalShortcuts portal where available (U-08) | Matrix of desktops (GNOME, KDE, others) documented |
| P8-T06 | B | Keychain via Secret Service; fallback encrypted file with passphrase if no keyring | Tests with and without keyring |
| P8-T07 | D,A | Security hardening: sandbox verification, hardening flags (PIE/RELRO), no debug leakage, SBOM, supply-chain gates (`cargo vet` for in-tree crates) | Hardening report in release checklist |
| P8-T08 | D | Soak/perf: 24 h with 100 tabs, memory-leak detection, crash handling, Host API fuzzing | Budgets met; no leak growth beyond threshold |
| P8-T09 | E,D | Docs and website (Bun): user docs, security docs, contributor docs, privacy statement | Published; brand-lint clean |
| P8-T10 | D,A | Signed release pipeline (§10.4), release checklist, rollback drill | One dry-run release promoted nightly → beta → release |

**Exit gate P8:** Linux GA checklist (Appendix E) signed by owner.

### Phase 9 — Windows (size XL)
| ID | Lane | Task | Deliverable / acceptance |
|---|---|---|---|
| P9-T01 | A | `mozconfig.windows`, toolchain (verify current Firefox Windows build requirements), CI runner, cache | Cold/warm build times recorded |
| P9-T02 | A,C | Host API platform fixes: titlebar/DPI/IME/touch; run golden + e2e on Windows | Goldens for Windows baseline; known differences documented |
| P9-T03 | A | Installer (per-user), uninstaller, default-browser registration for Windows 10/11, file associations | Clean-VM install tests |
| P9-T04 | A | Updater on Windows: resolve U-09 (maintenance service vs per-user in-place), MAR signing, staging | Update N-1 → N succeeds without admin prompts where possible |
| P9-T05 | B | Keychain via Credential Manager; global hotkey; tray | Tests on Win10/11 |
| P9-T06 | A | Mica-style window effects where available (U-13); high-contrast and theme integration | Visual tests; fallback themes |
| P9-T07 | A,D | Authenticode signing pipeline; SmartScreen reputation plan | Signed artifacts verified in CI |
| P9-T08 | B | Importers: Chrome, Edge, Brave, Firefox, Zen (+ Arc if present on Windows) | Fixture tests |
| P9-T09 | D | Test matrix: Win10/11, x64 (ARM64 optional later) | CI matrix green |

**Exit gate P9:** Windows beta (2 weeks dogfood) → GA checklist.

### Phase 10 — macOS (size XL)
| ID | Lane | Task | Deliverable / acceptance |
|---|---|---|---|
| P10-T01 | A | `mozconfig.macos` (arm64 first; x86_64 optional later), SDK/Xcode handling, CI macOS runner | Reproducible build |
| P10-T02 | A,C | Platform fixes: native titlebar/traffic lights, fullscreen, trackpad gestures, Dock/menu bar | Goldens for macOS baseline |
| P10-T03 | A | `.app`/`.dmg`, hardened runtime, notarisation, Gatekeeper tests | Notarised artifact installs on clean Mac |
| P10-T04 | A | Updater with MAR on macOS; staged updates | N-1 → N test |
| P10-T05 | B | Keychain, global hotkey, menu-bar helper | Tests |
| P10-T06 | A | Liquid Glass/vibrancy via widget patches (P3 tier; U-13) | Owner-approved patch; fallback theme |
| P10-T07 | B | Safari and Arc importers | Fixture tests |

**Exit gate P10:** macOS beta → GA.

### Phase 11 — Astra-exclusive features and long-term care
| ID | Lane | Task | Deliverable / acceptance |
|---|---|---|---|
| P11-T01 | all | **AI browser features**, one PRD at a time (problem, users, landscape, solution, goals, prioritised requirements — no implementation detail), then a TRD, then tasks. Candidate themes: page-aware assistant sidebar, cross-tab research, watchable agent browsing, automations/recipes, local-model privacy mode (evaluate Firefox's on-device ML runtime), workspace memory | `docs/prd/*.md`, `docs/trd/*.md` per feature, each with success metrics and eval cases |
| P11-T02 | A | Astra upstream watch: monthly review of Astra changes since the recorded base commit; cherry-pick policy; track under `docs/astra/ASTRA_WATCH.md` | Process documented and scheduled |
| P11-T03 | A | Flatpak, rpm, additional architectures/channels | Per-package test plans |
| P11-T04 | A | Annual ESR jump project (§6.5) scheduled when the next ESR reaches Beta | Calendar entry + radar job |

---

## 9. Testing strategy

### 9.1 Layers
| Layer | Tools | What it proves | Runs |
|---|---|---|---|
| Rust unit/property | `cargo nextest`, `proptest`, `insta` | Parsers, store, sync convergence, approval engine, blocker matching | every PR |
| Rust integration | in-memory SQLite, `MockHost` | Core behaviours without a browser | every PR |
| TS/UI unit | `bun test`, Svelte component tests | Components, stores, bridge shim | every PR |
| **Host API contract** | geckodriver/Marionette (chrome context) or in-tree browser-chrome tests against a **real Astra build** | Host API still behaves after any Firefox bump | PRs touching `overlay/`, `patches/`, `upstream.toml`; nightly |
| E2E | geckodriver/BiDi driving Astra UI | User journeys: tabs, spaces, split, tasks, notes, Work (with mock LLM) | nightly + release |
| Golden screenshots | standalone UI baseline vs in-Firefox captures | 1:1 UI parity | PRs touching `ui/`; nightly |
| Agent evals | `tests/eval/` on local fixture sites | Agent regressions | nightly (budget-capped) |
| Security | `cargo audit/deny/vet`, fuzzers (IPC, sync, URL/filter parsers), prompt-injection suite | Supply chain and hostile-input resilience | nightly + release |
| Perf | scripted benchmarks | Startup, RAM at 10/50 tabs, tab switch, blocker latency | nightly; gates on regression |
| Soak | 24 h scripted session | Leaks, crashes | pre-release |
| Install/update | clean VM/container matrix | Install, update N-1 → N, uninstall, rollback | pre-release |

### 9.2 Golden-screenshot parity method
1. P0-T07 produces the baseline by running the rebranded UI standalone with mocked IPC (fixed fonts, viewport sizes, light/dark, deterministic data).
2. In CI, the real Astra build is driven into the same states and captured.
3. Diffs use per-region masks (page content areas excluded; text anti-aliasing tolerance), threshold initially ≤ 1.5% per screen, ratcheted down as parity improves. Any intentional deviation needs an entry in `PARITY.md`.
4. Original Astra screenshots are used **locally only** to verify the rebrand changed nothing but text/logo regions.

### 9.3 Quality gates (block merge or release)
- **Brand-lint** (§3.4) · **License check** · **Footprint budget** (§6.7) · **Patch header lint** · **Host API schema drift** (generated types up to date)
- **Endpoint audit:** idle start must contact only classified hosts (P1-T07); diff reported on every bump
- **Telemetry guard:** build-flag assertions (F-05 flags present) and runtime pref assertions
- **Security:** no new high-severity advisories; `cargo vet` clean for in-tree crates; secrets scan
- **Perf budgets:** set in P4-T10 (placeholders until then: cold start ≤ stock Firefox + 15%; 50-tab sleeping RAM ≤ stock Firefox)

### 9.4 Test data rules
No live web in PR CI. Use local fixture servers (static pages, iframes, shadow DOM, ad-filter corpora, slow/failing networks). Live-web checks are opt-in nightly jobs with retries and quarantine.

---

## 10. CI/CD

### 10.1 Infrastructure
| Need | Choice |
|---|---|
| Fast jobs (fmt, clippy, tests, UI) | GitHub-hosted Linux runners |
| Engine builds (Firefox is large: plan for big disk/RAM, verify against current Firefox build docs) | Self-hosted or large cloud Linux runner with persistent `sccache`/`ccache` + engine source cache |
| Windows / macOS (Phases 9–10) | Dedicated runners added when those phases start |
| Caches | Cargo registry/target, Bun cache keyed by `bun.lock`, `engine/` source by `upstream.toml` hash, sccache remote storage |
| Secrets | GitHub Environments with required reviewers for signing keys/update-host credentials; never available to PR builds from forks |

### 10.2 Workflows
| Workflow | Trigger | Jobs |
|---|---|---|
| `ci-fast` | every PR/push | fmt, clippy, `cargo nextest`, `cargo deny`, `bun ci`, typecheck, `bun test`, schema drift, brand-lint, license check, patch-header lint |
| `ci-engine` | PRs touching `patches/ overlay/ forge/ config/ upstream.toml` + nightly | `forge fetch/import/overlay/build` (Linux), footprint budget, contract tests, endpoint audit |
| `ci-ui-golden` | PRs touching `ui/` + nightly | standalone capture, in-Firefox capture, diff report artifact |
| `nightly` | cron | full build, E2E, evals, fuzz (time-boxed), perf, soak (weekly), publish to `nightly` channel |
| `upstream-watch` | cron (daily) | check for newer ESR point release / security advisories; open bump PR; radar report |
| `bump` | on bump PR | `forge bump` pipeline (§6.5); upgrade report attached |
| `release` | tag `v*` or manual dispatch | build matrix → test → sign → package → upload to staging update host → promote with approval |
| `deps` | weekly | dependency update PRs (Cargo, Bun), license and audit checks |
| `windows-*`, `macos-*` | added in P9/P10 | platform build/test/sign |

### 10.3 Branching and versioning
Trunk-based: `main` is always releasable to `nightly`. Release branches `release/<major.minor>` for hotfixes. Task work happens on `agent/<task-id>-<short-slug>` branches (one per locked task, §1.5); only the orchestrator merges them into `main`. Version string: Astra semver plus upstream base in build metadata, e.g. `1.4.2+esr153.5`. Conventional commits generate the changelog. Every release artifact carries a build-provenance attestation and an SBOM.

### 10.4 Release pipeline
`build (reproducible-as-possible) → test suites → sign → package + MARs → upload to *staging* update channel → smoke-install/update tests on clean machines → owner approval gate → promote nightly → beta → release (staged % rollout) → monitor via opt-in crash reports? (none by default; use user-submitted diagnostics bundles only)`. A "pause rollout" switch and previous-version rollback are mandatory before the first public release.

---

## 11. Runbooks

### 11.1 Firefox point-release bump (target: ≤ 1 hour of human attention)
1. `upstream-watch` PR appears (only `upstream.toml` changed).
2. Read `docs/astra/UPSTREAM.md`: per-patch status, radar intersections, endpoint diff, new prefs.
3. All green → approve → promote through channels within the 72-hour security SLA (§6.6).
4. Any red → follow §11.3.

### 11.2 Annual ESR jump (153 → 175)
Start when the next ESR is in Beta. Order: (1) radar + new build flags/prefs review; (2) fix **Host API** modules and regenerate types; (3) re-apply patches one by one, shrinking or dropping any that upstream made unnecessary (use each patch's `Removal-Plan`); (4) full parity suite and golden suite; (5) 2–4 week canary; (6) release before the old ESR's end of life (confirm dates from Mozilla's calendar at the time).

### 11.3 Conflict triage guide
| Symptom | Likely cause | Action |
|---|---|---|
| Patch fails on context lines only | Surrounding code moved | Re-anchor hunk; update header `Verified-On` |
| Patch applies but contract test fails | Upstream semantics changed | Fix inside Host API module, not in UI/core |
| Build fails in Astra Rust component | gkrust/vendor/lock drift | Re-vendor, re-run `cargo vet`, adjust features |
| New outbound host at idle | New Mozilla service/feature | Classify in `ENDPOINTS.md`; disable via policy/pref/flag |
| UI golden diff only on chrome area | Upstream CSS/font/default changed | Pin style in overlay CSS |
| Subsystem removed upstream | Patch obsolete | Delete patch, update parity/tests |

### 11.4 Emergency security release
Trigger: upstream out-of-band security fix or Astra vulnerability. Steps: cut hotfix branch → bump or patch → fast path pipeline (skip soak, keep contract/smoke/sign) → staged rollout 10% → 100% within hours → post-incident note.

### 11.5 Rollback
Pause rollout; re-point channel to previous release; confirm clients on the bad version receive the fixed version as an upgrade (never rely on downgrades; Firefox profiles may refuse to run on older versions — keep profile-downgrade protection in mind).

---

## 12. Risk register
| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R-01 | Firefox internal changes break Astra every cycle | High | High | Host API seam, ESR, contract tests, footprint budgets (§6) |
| R-02 | Solo-maintainer security-update burden | High | High | 72 h SLA automation; don't distribute publicly until pipeline proven |
| R-03 | In-tree Rust blocker drags in vendoring/`cargo vet` friction | Med | Med | Minimal dependency surface; fallback proxy implementation |
| R-04 | Hiding Firefox chrome leaves dead code paths that still run | Med | Med | Hide first, prune gradually, track via startup profiling |
| R-05 | Content-slot layout hacks conflict with Firefox focus/IME/accessibility | Med | High | Spike S-01 early; a11y pass in P3; prefer upstream primitives |
| R-06 | 1:1 UI claim vs Gecko differences (fonts, scrolling, input) | Med | Med | Golden suite with masks; documented exceptions |
| R-07 | Extensions parity gap (no Chrome Web Store install) | High | Med | Curated gallery; set expectation (X-01) |
| R-08 | Sync crypto/design mistakes | Med | High | Spec + external review before release; fuzzing; E2EE with minimal server trust |
| R-09 | Agent prompt-injection or unsafe actions | High | High | Approval engine in core, injection suite, scoped FS/commands |
| R-10 | Build infrastructure cost/time (Firefox builds are heavy) | High | Med | Caches, `build faster` dev loop, nightly full builds only |
| R-11 | Licensing/trademark mistakes | Low–Med | High | Provenance docs, brand-lint, attribution checks, owner/legal review |
| R-12 | Platform-specific blockers (Wayland hotkeys, Windows updater service, macOS widget patches) | Med | Med | Early spikes U-08/U-09/U-13; documented fallbacks |
| R-13 | Astra diverges while Astra trails | Med | Low | Monthly watch (P11-T02); selective cherry-picks |
| R-14 | Mozilla services removal weakens security features (revocation, blocklists) | Med | High | Endpoint audit with explicit KEEP list; owner sign-off |

---

## 13. Appendices

### Appendix A — Build-flag starter set (verify every item against the pinned source)
Telemetry/data reporting off; Normandy off; health report off; crash reporter off at first (revisit with a self-hosted, opt-in design); parental controls off; background tasks off; legacy profile creation off; geckodriver enabled; custom branding dir; updater **enabled** (Astra needs it) with the update host from `branding/astra.toml`; `--disable-tests` and optimisation flags for release configs. Reference configs: Tor Browser / Mullvad Browser `mozconfig` commits (F-05).

### Appendix B — SQLite schema sketch (replace with Astra's actual schemas from P0-T03; keep migrations monotonic)
`profiles`, `spaces`, `folders`, `tabs_org` (astra_tab_id, space_id, folder_id, pinned, position, title, url, favicon_ref), `history` (url, title, visit_time, space_id), `sessions` (snapshot blobs), `favicons`, `settings`, `keymap`, `tasks`, `task_lists`, `task_links`, `notes_index` (path, hash, mtime, title), `time_sessions`, `focus_rules`, `blocker_lists`, `blocker_overrides`, `extensions_meta`, `agent_runs`, `agent_steps`, `canvas_items`, `memory_items`, `skills`, `mcp_servers`, `model_providers` (no secrets), `approvals_audit`, `sync_state`, `sync_outbox`, `schema_meta`. Conventions: integer primary keys + stable UUIDs for sync, `created_at/updated_at` in UTC, soft-delete tombstones for synced tables, WAL on, foreign keys on, `rusqlite_migration` with one migration per change and tests that upgrade from every previous schema version.

### Appendix C — IPC envelope and Host API example (illustrative; the schema files are authoritative)
Frame: 4-byte big-endian length + UTF-8 JSON. Envelope fields: `v` (protocol version), `id` (request id), `kind` (`req` / `res` / `evt`), `name`, `seq` (events), `payload`, `error` (`code`, `message`). Example command: `tabs.create { space_id, url, background }` → response `{ astra_tab_id }`; events: `tabs.created`, `tabs.updated`, `nav.committed`, `tabs.closed`. Unknown fields are ignored; unknown required versions fail fast with a clear error.

### Appendix D — Templates
**Task template (agents use for each task):** ID · Goal · Inputs · Steps · Files likely touched · Tests to add · Acceptance · Out of scope · Risks · Rollback.
**PR template:** what/why · linked task IDs · tests added/ran · upstream-footprint delta · brand/licence check · screenshots (UI) · checklist (no new Mozilla endpoints, no telemetry, docs updated).

### Appendix E — Owner inputs and checklists
**Owner must supply (blocks release builds, not development):** final logo and icon set; `app_id` and domain(s); update-host hostname; code-signing certificates (Windows Authenticode, Apple Developer ID); support/contact addresses; final decision on crash-report policy; legal/trademark review sign-off.
**Linux GA checklist:** all P0–P8 exit gates passed · parity matrix clean or exceptions documented · endpoint audit clean · brand-lint clean on artifacts · SBOM + licences shipped · update N-1 → N and rollback drills passed · security review done (Host API, IPC, approvals, sync) · 2-week beta without data-loss bugs · docs and privacy statement published.

### Appendix F — Glossary
**ESR** Extended Support Release · **MAR** Firefox update archive · **Balrog** Mozilla's update server software · **Host API** Astra's single seam to Firefox internals · **gkrust** Firefox's Rust aggregation crate linked into libxul · **XPCOM** Firefox component model · **JSWindowActor** Firefox mechanism for parent↔content messaging · **BiDi** WebDriver BiDi automation protocol · **Container** Firefox contextual identity (isolated storage) · **Golden** reference screenshot.

### Appendix G — Source list (retrieved 2026-11-01)
- Astra repository README: https://github.com/astra-browser/Astra
- Firefox Git migration (official repo `mozilla-firefox/firefox`): Mozilla "Firefox Git Migration Update/Status" documents (2025)
- ESR/rapid-release calendar: https://whattrainisitnow.com/calendar/ · https://www.theregister.com/software/2026/07/17/mozilla-speeds-firefox-release-schedule-to-biweekly/5274423 · https://endoflife.ai/article-firefox-esr-eol
- Firefox update system docs: https://firefox-source-docs.mozilla.org/toolkit/mozapps/update/docs/Implementation.html · Ghostery update system: https://github.com/ghostery/user-agent-desktop/blob/2022-11-29/docs/update-system.md
- Rust in Firefox: https://firefox-source-docs.mozilla.org/build/buildsystem/rust.html · https://searchfox.org/mozilla-central/source/xpcom/rust/xpcom/src/lib.rs
- Fork build flags: Tor Browser / Mullvad Browser commits on gitlab.torproject.org (e.g. commits 97d534ba, 792ebcc2, 49da7d23)
- Zen Browser / Surfer: https://github.com/zen-browser/desktop · https://www.npmjs.com/package/@zen-browser/surfer
- WebDriver BiDi modules: https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules
- Firefox split view / vertical tabs: Firefox Nightly News issue 200; Firefox 150 release coverage; Firefox 157 "Nova" coverage
- Library docs via Context7: `/websites/rs_rusqlite_migration`, `/oven-sh/bun`

*End of plan.*