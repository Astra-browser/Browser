# Inventory — first cut (P0-T03, 2026-11-01, from `folder_context` snapshot)

Deep pass still required. Code wins over README where they disagree.

## Rust workspace (28 crates under `crates/`)

| Crate | Role (one line) |
|---|---|
| `…-account` | Account client/service/vault/tasks |
| `…-agent-controller` | Work agent decision/action/probe logic (+ many `work_*` test modules) |
| `…-agentic` | Agentic primitives |
| `…-agent-model-catalog` | Model catalog for BYO providers |
| `…-agent-provider-transport` | Provider transport (streaming/tool-calls) |
| `…-agent-runtime` | Agent runtime |
| `…-app` | App shell + **`skills/` (25 bundled skills, see below)** |
| `…-blocker*` (3) | Blocker core / service / list updater (adblock-rust based) |
| `…-core` | Core services |
| `…-credentials` | OS keychain access |
| `…-decision` | Decision engine |
| `…-engine` | Engine abstraction |
| `…-import` | Browser importers (chromium.rs, firefox.rs, icons.rs) |
| `…-ipc` | Tauri IPC surface |
| `…-mcp` | MCP client (Linear/Notion/Sentry/Stripe/Figma per README) |
| `…-notes` | Notes (index.rs; Markdown-on-disk per plan) |
| `…-page-assist` | Sidebar assistant (`page_assist_ask`, `page_assist_cite`) |
| `…-private-fs` | Scoped filesystem for agents |
| `…-store` | SQLite store (`migrations.rs`, `legacy.rs`, hub/session) |
| `…-terra-macos-probe` | macOS-only probe helper |
| `…-update-transport` | Update transport (tough-based) |
| `…-voice` | Voice input |
| `…-webext{,-macos,-windows}` | Extension plumbing per OS |
| `…-work-composition` | Work canvas composition |

Vendor dirs: `vendor/{adblock,tao,tauri,tauri-runtime-wry,tauri-plugin-updater}`
+ `patches/`, `xtask/`, `scripts/`, `assets/`, `desktop/`, `frame/`, `eval/`, `docs/`.

## IPC surface (Tauri)

- **263 command fns** in `desktop/src` (`#[tauri::command]` +1 line): `about_info`,
  `account_*` (22: avatar, email/code flows, sessions, plans, usage, revoke…),
  `blocker_*` (6), `bookmark_*`, `browser_credential_*`, `browser_open_url`,
  `browsing_data_call`, `*_menu_popup`, `default_browser_*`, `diagnostics_*`,
  `divider_*`, `download_*`, `essentials_*`, `export_browser_data`,
  `favicon_probe`, `focus_control`, `haptic`, `history_*`, `import_*` (cancel,
  permission, sources, start), `keymap_*`, `launcher_*` (search/run/shortcut),
  `link_describe`, `login_item_*`, `media_*`, `newtab_*`, `note_call`,
  `onboarding_*`, `page_assist_*`, … (full enumeration → `docs/astra/ipc-surface.md`)
- UI invokes via Tauri `invoke`; **grep for `invoke("…")` call-sites is P0-T03
  follow-up** (only ~4 distinct literal matches surfaced; most calls are wrapped).
- Events: `emit`/`listen` strings observed (`theme.dark`, `split.choose`,
  `material.*`) — full event list also goes to `ipc-surface.md`.

## UI (`frame/` Svelte + `desktop/` webviews)

- Entries: `browser` (`BrowserApp.svelte`, `Shell.svelte`, `WorkWorkspace.svelte`,
  `SkyLight.svelte`), `onboarding`, `panel`.
- 29 feature dirs: account, address, assist, blocker, bookmarks, dock, downloads,
  essentials, extensions, history, library, media, newtab, notes, onboarding,
  panel, permissions, search, settings, sidebar, source, split, tabs, tasks,
  time, tools, updates, webext, work (+ `app/`, `domain/`, `session/`, `shared/`).
- Look-test hosts exist (`*Look.svelte`, `IconStrip`) — reusable for P0-T07 goldens.

## Data & skills

- SQLite via `…-store` (`migrations.rs` + `legacy.rs` = migration history to port);
  `CREATE TABLE` also in `…-import`, `…-notes`.
- 25 bundled skills in `crates/…-app/skills/`: campaign-plan, compare-and-choose,
  competitor-landscape, exam-prep, explain-a-subject, explain-code, fix-a-bug,
  inbox-triage, investor-list, job-search, learning-path, map-a-project,
  market-map, meeting-prep, moodboard, plan-my-day, pricing-research, research,
  review-a-change, show-what-you-can-do, system-design, today-from-my-messages,
  trip-planning, ui-teardown, weekly-status.
- Eval: `eval/agentic-browsing` (browse-baseline, capabilities,
  native-input-matrix, semantic-runtime macos/smoke + README) + 4 work JSON suites.

## Follow-ups (still todo in P0-T03)

1. Emit full `docs/astra/ipc-surface.md` (every command + event + payload type).
2. Generate `docs/astra/PARITY.md` (README claims vs code; code wins).
3. Enumerate settings keys, shortcuts, storage schemas, the 20 verified
   extensions, onboarding flow, `eval/agentic-browsing` harness shape.
