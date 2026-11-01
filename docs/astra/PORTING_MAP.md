# Porting map — draft (P0-T04, 2026-11-01)

## KEEP (port logic, drop Tauri/Wry coupling at the seam)

`…-core`, `…-store` (+ `migrations.rs`/`legacy.rs`), `…-ipc` (shapes feed
`astra-proto`), `…-blocker*` (matching logic → `astra-blocker`; update flow
→ list-update service), `…-notes`, `…-import`, `…-credentials` (keychain),
`…-private-fs` (scoped FS), `…-mcp`, `…-agent-*` + `…-work-composition` +
`…-page-assist` (Phase 6), `…-account` client shapes (Phase 7),
`…-update-transport` (adapt to MAR flow), `…-app/skills` (all 25, rebrand text).

## ADAPT (keep, behind a new seam)

- `desktop/src` Tauri commands (263) → split: pure logic moves into
  `astra-core`; window/webview acts move behind `BrowserHost`.
- `frame/` Svelte UI → `ui/` Bun workspace; Tauri `invoke`/`listen` calls
  rerouted through `@astra/bridge` (P2-T08).
- `…-engine`, `…-decision`, `…-agentic`, `…-voice`, `…-media` paths: keep
  behind `BrowserHost` media/clipboard/audio seams.
- `…-webext*` → Firefox WebExtensions manager + curated gallery (X-01).

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
