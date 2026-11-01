# Astra architecture decision log (P0-T10, §1.2)

Seeded from `plan.md` §2. New entries append as `D-21`, `D-22`, …

| ID | Decision | Status / notes |
|---|---|---|
| D-01 | Engine = Gecko from Firefox ESR, starting ESR 153 | Accepted (plan). Point release + tarball URL unverified (U-10) |
| D-02 | Repo model = pinned upstream + patch series + overlay, assembled by `astra-forge` | Accepted (plan) |
| D-03 | Visible UI is 100% Astra (Svelte); Firefox chrome hidden first, pruned later | Accepted (plan) |
| D-04 | Process model: Gecko host + `astra-core` sidecar; optional `astra-agent` helper | Accepted (plan) |
| D-05 | State ownership: Firefox owns live tab objects; `astra-core` owns organisation | Accepted (plan) |
| D-06 | IPC = length-prefixed JSON frames over stdio pipes | Provisional — spike P1-T09 decides; fallback loopback WebSocket |
| D-07 | Storage = `rusqlite` + `rusqlite_migration`, WAL; notes as Markdown on disk | Accepted (plan) |
| D-08 | Rust by default; Svelte/TS UI; JS only for Gecko glue + Bun tooling; C++ only in hook patches | Accepted (plan) |
| D-09 | Bun = package manager, workspaces, script + TS test runner; `bun.lock` committed | Accepted (plan); source snapshot uses pnpm — migration is P3-T01 work |
| D-10 | Blocker = `adblock-rust` in-process Gecko component; fallback local filtering proxy | Accepted (plan) |
| D-11 | Extensions = Firefox WebExtensions + curated gallery | Accepted (plan); parity exception X-01 |
| D-12 | Spaces/profiles = Firefox containers + per-profile dirs | Provisional — spike S-02 decides exact mapping |
| D-13 | Accounts/sync optional, local-first, E2EE, Rust server behind `Store` trait | Accepted (plan); Phase 7 |
| D-14 | UA keeps Firefox-compatible token; Astra branding elsewhere | Accepted (plan) |
| D-15 | No telemetry/experiments/Mozilla services except audited allow-list | Accepted (plan); enforced by endpoint-audit gate |
| D-16 | Updates via Firefox built-in updater pointed at Astra update host, static signed manifests first | Accepted (plan) |
| D-17 | Keep source snapshot's `rustfmt.toml`, `deny.toml`, `rust-toolchain.toml` conventions; TS linter follows source snapshot, else Biome | Accepted (plan) |
| D-18 | Astra source MPL-2.0; every file carries the MPL header | Accepted (plan) |
| D-19 | All names/IDs from `branding/astra.toml` | Accepted (plan); file created with OWNER_DECISION placeholders |
| D-20 | Linux packaging order: tarball → AppImage → `.deb` | Accepted (plan) |
| D-21 | Reference source for the port = `folder_context` snapshot (git-ignored), not any external checkout | Decided 2026-11-01 (owner direction) |
| D-22 | `plan.md` carries Astra branding only; provenance/attribution lives in `PROVENANCE.md` | Decided 2026-11-01 (owner direction) |
| D-23 | Orchestration: one orchestrator (plan/assign/test/review) + worker subagents, one locked task + one `agent/<task>-<slug>` branch each, STATE.md as lock registry | Decided 2026-11-01 (owner direction); plan §1.5 + §10.3 |
| D-24 | Commit every change; workers push branches, only the orchestrator merges to `main` | Decided 2026-11-01 (owner direction); plan §1.1 + §1.5 |
