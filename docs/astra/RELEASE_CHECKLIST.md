# Release checklist — owner items + pipeline proofs (started P1-T03)

Status words: `PLACEHOLDER` (dev default in tree now) → `PROVIDED` (owner gave
the final value) → `VERIFIED` (rendered into a build and checked). Nothing
here blocks dev builds; everything here blocks a public release.

## A. Owner-supplied values (placeholders now, replaced entirely at release)

| # | Item | Lives in | Current placeholder | Blocks |
|---|---|---|---|---|
| R-01 | `app_id` (reverse-DNS) | `branding/astra.toml` | `OWNER_DECISION` → builds use `com.astra.dev` | Public builds (profile/taskbar/keychain identity) |
| R-02 | `vendor` | `branding/astra.toml` | `OWNER_DECISION` → builds use `Astra (dev placeholder)` | Public builds, about dialog, installer |
| R-03 | `homepage`, `support_url`, `docs_url` | `branding/astra.toml` | `OWNER_DECISION` (not yet rendered anywhere) | Public builds |
| R-04 | `update_host` + MAR signing setup | `branding/astra.toml` | `OWNER_DECISION` → builds use `https://localhost:0/placeholder-astra-update` | Updater E2E (P8) |
| R-05 | Signing certificates | Owner-held, never committed | — | Installers: Windows Authenticode, macOS Developer ID (deferred platform), Linux deb-repo key |
| R-06 | Final logo + icons (SVG, PNG, `icns`, `ico`) + brand fonts? | `branding/assets/` (masters) → `overlay/astra/branding/` | **PROVIDED (D-38)** — sail mark, all sizes generated | Release packaging (P8) |
| R-07 | Crash-report policy: self-hosted opt-in vs diagnostics-bundle-only | Decision → P8 wiring | Undecided (P1-T02/P8) | Privacy posture sign-off |
| R-08 | Password/autofill: keep Firefox login-manager vs extensions-only | Decision → P4-T09 | Undecided | P4 scope |
| R-09 | Golden threshold: accept ≤ 1.5% per-screen pixel diff? | Decision → P3-T11 | Undecided | Visual-parity gate |
| R-10 | Sync crypto reviewer (external, before Phase 7 ships) | Decision → P7-T01 | Undecided | Sync release |
| R-11 | Legal/trademark review of final identity | External review | Not started | Any public distribution (plan §3) |

## B. Pipeline proofs (engineering, due before release)

| # | Proof | Owner action |
|---|---|---|
| P-01 | 72 h security-SLA automation proven (rebuild → test → ship inside the window) | Confirm (R-02 in plan numbering) |
| P-02 | Signed pipeline dry-run: nightly → beta → release promotion (P8-T10) | Approve promotion |
| P-03 | Rollback drill + install/update matrix (N-1 → N, uninstall) | — |
| P-04 | 24 h soak, hardening report, SBOM, `cargo vet` clean | Review hardening report |
| P-05 | License/attribution audit (`cargo deny`, Bun license check, brand-lint on artifacts) | — |

## How replacement works (so placeholders never leak)

1. Owner provides a value → it goes into `branding/astra.toml` (or the
   `overlay/astra/branding/` art drop) on a branch; `OWNER_DECISION` removed.
2. `forge overlay` re-renders; `forge config` re-renders; rebuild.
3. `brand-lint` + a release-gate job fail the build if any `PLACEHOLDER` or
   `OWNER_DECISION` string survives outside `docs/` provenance files.
4. Row moves to `VERIFIED` here only after step 3 is green on a release build.
