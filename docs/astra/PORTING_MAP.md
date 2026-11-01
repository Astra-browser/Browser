# Porting map (P0-T04, 2026-11-01; grounded in T03a on worker branch)

Command census: **267** Tauri commands (not 263 — recount via
`docs/astra/ipc-surface.md`), grouped by prefix below. Groups map 1:1 onto
Host API modules (§6.4) or `astra-core` domains.

## KEEP (port logic, drop Tauri/Wry coupling at the seam)

`…-core`, `…-store` (+ `migrations.rs`/`legacy.rs`), `…-ipc` (shapes feed
`astra-proto`), `…-blocker*` (matching logic → `astra-blocker`; update flow
→ list-update service), `…-notes`, `…-import`, `…-credentials` (keychain),
`…-private-fs` (scoped FS), `…-mcp`, `…-agent-*` + `…-work-composition` +
`…-page-assist` (Phase 6), `…-account` client shapes (Phase 7),
`…-update-transport` (adapt to MAR flow), `…-app/skills` (all 25, rebrand text).

## ADAPT (keep, behind a new seam)

- `desktop/src` Tauri commands (267) → split: pure logic moves into
  `astra-core`; window/webview acts move behind `BrowserHost`.
- `frame/` Svelte UI → `ui/` Bun workspace; Tauri `invoke`/`listen` calls
  rerouted through `@astra/bridge` (P2-T08).
- `…-engine`, `…-decision`, `…-agentic`, `…-voice`, `…-media` paths: keep
  behind `BrowserHost` media/clipboard/audio seams.
- `…-webext*` → Firefox WebExtensions manager + curated gallery (X-01).

## Command groups → Host API modules (from T03a census)

| Prefix (count) | Host API module / core domain |
|---|---|
| work (53) | `astra-agents` + `Content`/`Panes` tools (Phase 6) |
| account (29) | `astra-account` → Astra Cloud client (Phase 7); local stubs earlier |
| page (26), tab (4), tabs (15), windows (2) | `Tabs`, `Navigation`, `Windows`, `Content`, `Session` |
| web (15: webext group) | `Extensions` (+ gallery) |
| launcher (8), newtab (4), sidebar (6), divider (3), ui (2), menu/chrome/add (1 each) | Shell UI state in core; `Windows`/`Native` for global parts |
| spaces (8), profiles (6), profile (3) | `Containers` (spike S-02) |
| blocker (7) | `Net` hook + `Content` cosmetic hiding |
| voice (7), media (4), haptic (1) | `Native` (OS services) via `BrowserHost` seams |
| keymap (4), setting (2) | `settings`/`keymap` store in core; `Boot` applies |
| import (4), bookmark (2), history (2), browsing (1) | `astra-import`, history store, `Session` |
| download (2), favicon (1), site (2) | `Downloads`, favicon cache, `Content` metadata |
| diagnostics (2), resource (2), operation(s) (3), focus (1), link (1), open (1), export (1), run (1), swipe (1), system (1), time (1), tools (1), zoom (1), about (1), login (3), browser (3), panel (4), onboarding (2), update (4), extension (2), essentials (2), default (2) | Split per-command: `Native`, `Downloads`, `Permissions`, `Boot`, `Session`, updater (Phase 8); each assigned at P2-T05 |

## DROP (Gecko or platform owns it now)

Tauri/Wry runtime + `vendor/*` forks, `…-terra-macos-probe` (replaced by
widget work or dropped), Tauri updater + `tough` flow (replaced by MAR
updater), `patches/` + `xtask/` (superseded by `forge/` + `patches/` patch
series), updater OS services (replaced per-platform in P8–P10).

## `BrowserHost` trait (draft for review)

```rust
// crates/astra-host-trait — the seam replacing Tauri/Wry adapters (U-12).
// Implementors: MockHost (tests/dev) and GeckoHost (over Host API + BiDi).
pub trait BrowserHost {
    type Error;
    // windows / tabs / navigation / panes / containers / content /
    // downloads / permissions / extensions / session / native …
    // Full method list derives from docs/astra/ipc-surface.md (P0-T03).
}
```

Rules: UI and `astra-core` never touch Firefox internals or Tauri APIs —
only this trait (enforced by lint). `GeckoHost` is the only implementor
allowed to speak the Host API wire format.
