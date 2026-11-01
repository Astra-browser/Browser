# Parity matrix (P0-T03b, 2026-11-01) — README claims vs code; code wins

Source: snapshot `README.md` (279 lines) + code (`desktop/src`, `frame/src`,
`crates`, `eval/`). Status values: `ported-pending` (exists in source, port
scheduled), `deviates` (honest exception Xn), `verifying` (claim needs a test).

## Shell

| Claim (README) | Code evidence | Astra implementation | Phase / status |
|---|---|---|---|
| Vertical tabs, quiet sidebar | `frame/src/features/{sidebar,tabs,split}` | Svelte UI; tabs are Firefox `<browser>` in content slots | 3, ported-pending |
| Spaces, profiles, pinned tabs, folders, split view | same + `d:lib.rs` tabs fns | Containers/profiles (spike S-02) | 3, ported-pending |
| New-tab sky w/ time, focus, day's tasks | `frame/src/features/newtab` + `*Look.svelte` hosts | Port newtab + time/tasks widgets | 3/5, ported-pending |
| Liquid Glass (macOS 26) / Mica (Win 11) | `material.*` events | Widget patches P9–P10; fallback themes first | X-02, deviates |
| Launcher (`⌘⇧Space`), tabs/history/notes/commands; anything typed → task | `launcher_*` cmds (11), `launcher_trigger*` | Launcher window + `astra-agent` helper | 8, ported-pending |
| Rebindable shortcuts | `keymap_*` cmds + `prev:keymap-changed` | Core-owned keymap, Host API routing | 3, ported-pending |
| Onboarding + welcome flow | `onboarding_*`, `frame/src/app/onboarding` | Port flow; import stubbed to P4 | 3/4, ported-pending |

## Browse

| Claim | Code evidence | Astra implementation | Phase / status |
|---|---|---|---|
| Native engine, fast/light | WebKit/WebView2 (platform) | **Gecko everywhere** | X-04, deviates (intended) |
| ~30 MB download | release artifacts | Engine bundled, expect ~3×+ | X-03, deviates |
| Sleeping inactive tabs | tab cmds + policy in core | Firefox discard via `Tabs` + core policy | 4, ported-pending |
| Native blocker (adblock-rust, EasyList/EasyPrivacy), click-to-hide | `blocker_*` cmds (6), `…-blocker*` crates | In-process Gecko component, `vendor`+`vet` | 4, ported-pending |
| Chrome Web Store install, 20 verified | `catalog.ts` (47 listed IDs), `webext` cmds | Curated Firefox/AMO gallery | X-01, deviates |
| Import Chrome/Safari/Arc/Zen/Firefox/Brave/Edge | `…-import` (chromium.rs, firefox.rs, icons.rs), `import_*` cmds | `astra-import` + onboarding UI | 4, ported-pending |
| Private windows keep nothing | private-browsing handling in core/store | Firefox PB + core purge guarantees + forensic test | 4, ported-pending |
| Downloads manager, PDF viewing | `download_*`, viewer wiring | Port UI; Firefox built-in PDF viewer | 4, ported-pending |

## Built-in: tasks, time, notes

| Claim | Code evidence | Astra implementation | Phase / status |
|---|---|---|---|
| NL tasks ("call Anna tomorrow at 3"), lists/priorities/deadlines/subtasks/linked page | task cmds, `…-store` | `astra-store` + ported parser + TZ/DST tests | 5, ported-pending |
| Per-site time on-device, focus timer, site blocking | `…-ipc/time.rs`, time cmds/events | Tab-activity → core; `Net`-hook blocking | 5, ported-pending |
| Markdown notes you own, external edits appear | `…-notes` (index.rs), `note_call`, `notes-changed`, `note-open-requested` | Files on disk + watcher + index | 5, ported-pending |

## Work (agents)

| Claim | Code evidence | Astra implementation | Phase / status |
|---|---|---|---|
| Outcome → canvas, visible steps, memory/history recall, skills | `work_*` cmds (~60), `…-agent-*`, `…-work-composition`, `…-ipc/work*.rs` | `astra-agents` runtime + canvas UI | 6, ported-pending |
| Parallel helpers in own panes, sources beside canvas | helper/session cmds, `Panes` concept | Helper = container + visible `Panes` | 6, ported-pending |
| Tables/charts/diagrams/plans/code/docs; plan → tasks; save → note | canvas/product cmds (`work_save_calendar`, `work_edit_draft`, …) | Port renderers | 6, ported-pending |
| Reads/edits granted folders, runs commands, hands off to Claude Code/Codex | `…-private-fs`, command runner, handoff cmds | Scoped FS + approval gates | 6, ported-pending |
| MCP (Linear/Notion/Sentry/Stripe/Figma), `gh` CLI | `…-mcp` crate | MCP client + per-server permissions | 6, ported-pending |
| Approval before anything posts/merges/changes | admission/operation cmds (`operation_status`, `operations_reconcile`) | Approval engine in core + injection suite | 6, ported-pending |
| BYO models (9 providers) + local (Ollama/LM Studio/compatible); keys in keychain | `work_models` cmds, `…-agent-model-catalog`, `…-credentials` | Provider traits + keychain | 6, ported-pending |
| 25 bundled skills + user skills | `crates/…-app/skills/` (25 verified present) | Port verbatim (minus branding) | 6, ported-pending |
| Sidebar assistant (`⌘E`), page-aware, Continue in Work | `page_assist_*`, `…-page-assist` | Port panel + handoff | 6, ported-pending |
| Account for AI service w/ free credits; usage counting | `account_*` (22 cmds), `…-account` | Astra Cloud accounts (Phase 7); local-first without account | 7, ported-pending |

## Privacy, updates, quality

| Claim | Code evidence | Astra implementation | Phase / status |
|---|---|---|---|
| No first-party telemetry; no account needed; PB keeps nothing | privacy settings cmds, store purge paths | D-15 + endpoint-audit gate; PB forensic test | 1/4/7, verifying |
| AI requests pass through, usage counted only | account usage cmds | Same contract on Astra Cloud | 7, ported-pending |
| Background updates, relaunch to update | `updates*` (tauri/updater + tough) | Firefox MAR updater + own host | 8, ported-pending |
| `eval/agentic-browsing` + work JSON suites | `eval/` (5 suites) | `tests/eval/` on local fixtures | 6, ported-pending |

## Deliberate deviations (register X-01…X-06 in plan §7.1 — unchanged)

X-01 Chrome Web Store → AMO gallery · X-02 Glass/Mica deferred · X-03 bundle
size · X-04 Gecko everywhere · X-05 Linux-first (was unsupported) · X-06 Astra
identity. No new deviations found in code.
