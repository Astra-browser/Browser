# Provenance (P0-T06) — brand-lint allow-listed file

## Base snapshot

- Astra is derived from a file snapshot of the Zephium browser source
  (MPL-2.0, https://github.com/zephium-browser/Zephium), provided by the owner
  at `/home/rem/Projects/Astra/folder_context` (git-ignored reference copy).
- The snapshot carries **no VCS metadata**: no commit SHA could be recorded.
  Snapshot date: 2026-11-01. Rust toolchain pin: 1.95.0 (`rust-toolchain.toml`).
- The Zephium name, logo and branded assets are **not licensed** (per that
  project's README) and are **not** reused: all user-visible branding is Astra.

## License compliance (non-negotiable)

- Keep MPL-2.0 file headers and existing copyright notices in derived files.
- Ship `LICENSE` (MPL-2.0) and `NOTICE`: "Portions derived from Zephium,
  MPL-2.0", plus third-party notices (EasyList/EasyPrivacy CC BY-SA 3.0 per
  `blocker/seed/NOTICE`; Tauri/Wry/adblock-rust if any
  remain — checked via `cargo-about` / Bun license scan in CI).
- Modified MPL files stay MPL; their source remains available.
- This is engineering guidance, **not legal advice** — owner runs the final
  license/trademark review before public distribution.

## Blocker upstream (D-42, 2026-11-07)

- Engine: Brave `adblock-rust` (MPL-2.0), used through the audited
  `adblock 0.12.1` crate already vendored by Gecko. Copyright Brave Software,
  Inc. and contributors. The crate source is not modified by Astra.
- Resources: `brave/adblock-resources` (MPL-2.0; generic uBlock-derived
  scriptlets only). Catalog: `brave/adblock-lists` +
  `brave/adblock-lists-mirror` for structure/provenance. Brave-owned list
  sources and `brave-*` resources are excluded; see `blocker/NOTICE.md` and
  `docs/astra/BLOCKER_UPSTREAM.md`.
- Filter lists keep their own licences (EasyList CC BY-SA 3.0, uBlock Origin
  GPL-3.0-or-later, URLhaus CC BY-SA 4.0, AdGuard GPL-3.0-or-later, others as
  recorded per list in `blocker/lists/catalog.json`).
