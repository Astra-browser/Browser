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
  `assets/blocker-seed/v1/NOTICE` when ported; Tauri/Wry/adblock-rust if any
  remain — checked via `cargo-about` / Bun license scan in CI).
- Modified MPL files stay MPL; their source remains available.
- This is engineering guidance, **not legal advice** — owner runs the final
  license/trademark review before public distribution.
