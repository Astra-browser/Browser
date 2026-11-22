# Astra documentation

Start here before changing code:

| Need | File |
|---|---|
| Scope contract (authoritative) | [`astra/SCOPE.md`](astra/SCOPE.md) |
| Task state + remaining wiring backlog | [`astra/STATE.md`](astra/STATE.md) |
| Decisions / rationale | [`astra/DECISIONS.md`](astra/DECISIONS.md) |
| Run + rebuild the dev build | [`astra/DEV_SETUP.md`](astra/DEV_SETUP.md) |
| Verification and performance gates | [`astra/TESTING.md`](astra/TESTING.md) |
| Known limits and deferred work | [`astra/KNOWN_LIMITS.md`](astra/KNOWN_LIMITS.md) |

Everything in `astra/` is either a **contract** (how a subsystem works, pinned by
code or tests), a **plan** (intent, dies when the work lands) or a **report**
(what happened on a date). Contracts stay here; plans and reports move to
`docs/archive/` once they are settled. `tools/docs-check.mjs` enforces that every
doc below stays reachable.

## Engine, build and provenance

| File | Covers |
|---|---|
| [`astra/UPSTREAM.md`](astra/UPSTREAM.md) | pinned Firefox ESR source, update policy |
| [`astra/ASSEMBLY.md`](astra/ASSEMBLY.md) | overlay assembly and frame builders |
| [`astra/BUILD_FLAGS.md`](astra/BUILD_FLAGS.md) | configure flags and build variants |
| [`astra/BUILD_TIMES.md`](astra/BUILD_TIMES.md) | measured build durations, LTO notes |
| [`astra/PARITY.md`](astra/PARITY.md) | Firefox parity matrix and exceptions |
| [`astra/PORTING_MAP.md`](astra/PORTING_MAP.md) | upstream file → Astra file map |
| [`astra/INVENTORY.md`](astra/INVENTORY.md) | source tree inventory |
| [`astra/PROVENANCE.md`](astra/PROVENANCE.md) | attribution and licensing provenance |
| [`astra/LICENSES.md`](astra/LICENSES.md) | dependency licence inventory |
| [`astra/SHELL_APP.md`](astra/SHELL_APP.md) | shell entry points and startup |
| [`astra/FRAME.md`](astra/FRAME.md) | window frame and chrome structure |
| [`astra/SLEEPING.md`](astra/SLEEPING.md) | tab sleeping and memory reclamation |

## IPC, host and storage

| File | Covers |
|---|---|
| [`astra/ipc-surface.md`](astra/ipc-surface.md) | every IPC message, payload and owner |
| [`astra/HOST_API_v1.md`](astra/HOST_API_v1.md) | Host API v1 contract |
| [`astra/NATIVE_BINDING.md`](astra/NATIVE_BINDING.md) | native binding and generated bindings |
| [`astra/CORE_STORE.md`](astra/CORE_STORE.md) | `astra-core` store schema and migrations |
| [`astra/ENDPOINTS.md`](astra/ENDPOINTS.md) | network endpoints and the audit allow-list |
| [`astra/HISTORY_MIRROR.md`](astra/HISTORY_MIRROR.md) | history mirror into Places |
| [`astra/SESSION.md`](astra/SESSION.md) | session restore and handoff state |

## Browser surfaces

| File | Covers |
|---|---|
| [`astra/NATIVE_SURFACES.md`](astra/NATIVE_SURFACES.md) | split view, groups, peek, per-space history |
| [`astra/UI_REFRESH.md`](astra/UI_REFRESH.md) | UI v2 layout contract (D-52/D-53) |
| [`astra/HIDING.md`](astra/HIDING.md) | how native chrome is suppressed |
| [`astra/DIALOGS.md`](astra/DIALOGS.md) | dialogs and prompts |
| [`astra/DOWNLOADS.md`](astra/DOWNLOADS.md) | download lifecycle |
| [`astra/A11Y.md`](astra/A11Y.md) | accessibility requirements |
| [`astra/SPACES.md`](astra/SPACES.md) | spaces, containers and profiles |
| [`astra/PRIVATE.md`](astra/PRIVATE.md) | private windows and isolation rules |
| [`astra/PRIVACY_PREFS.md`](astra/PRIVACY_PREFS.md) | privacy preference semantics |
| [`astra/FINGERPRINTING.md`](astra/FINGERPRINTING.md) | fingerprinting resistance |
| [`astra/SETTINGS_AUDIT.md`](astra/SETTINGS_AUDIT.md) | live Settings audit on Windows |
| [`astra/SETTINGS_PARITY_PLAN.md`](astra/SETTINGS_PARITY_PLAN.md) | settings parity plan (superseded by the audit) |
| [`astra/PASSKEYS.md`](astra/PASSKEYS.md) | platform authenticator and passkey vault |
| [`astra/PASSWORD_DECISION.md`](astra/PASSWORD_DECISION.md) | password manager decision |
| [`astra/BLOCKER.md`](astra/BLOCKER.md) | ad blocker contract |
| [`astra/BLOCKER_WIRING.md`](astra/BLOCKER_WIRING.md) | blocker wiring into the engine |
| [`astra/BLOCKER_UPSTREAM.md`](astra/BLOCKER_UPSTREAM.md) | blocker upstream sync notes |

## Extensions

| File | Covers |
|---|---|
| [`astra/EXTENSIONS.md`](astra/EXTENSIONS.md) | extension support and gallery |
| [`astra/EXTENSIONS_COMPAT.md`](astra/EXTENSIONS_COMPAT.md) | Chrome extension compatibility |
| [`astra/EXTENSION_CORPUS_2026-11-08.md`](astra/EXTENSION_CORPUS_2026-11-08.md) | dated corpus report (frozen) |

## Performance

| File | Covers |
|---|---|
| [`astra/PERF.md`](astra/PERF.md) | performance contract and budgets |
| [`astra/PERF_PLAN.md`](astra/PERF_PLAN.md) | earlier performance proposal |
| [`performance/STRESS_REPORT.md`](performance/STRESS_REPORT.md) | consolidated stress results |
| [`performance/OBSERVATIONS.md`](performance/OBSERVATIONS.md) | per-run observations |

## Platforms

| File | Covers |
|---|---|
| [`astra/WINDOWS_MASTER_PLAN.md`](astra/WINDOWS_MASTER_PLAN.md) | Windows port master plan (D-51) |
| [`astra/WINDOWS_PORT.md`](astra/WINDOWS_PORT.md) | Windows port build notes |
| [`astra/REBRAND-ui.md`](astra/REBRAND-ui.md) | UI rebrand notes |

## Agent track (deferred, D-48)

Kept as specs for the build that turns Work on; not part of Beta 1.

| File | Covers |
|---|---|
| [`astra/AGENTS_DESIGN.md`](astra/AGENTS_DESIGN.md) | agent runtime design |
| [`astra/APPROVALS.md`](astra/APPROVALS.md) | approval gate engine |
| [`astra/TOOLS.md`](astra/TOOLS.md) | tool layer and schemas |
| [`astra/HELPERS.md`](astra/HELPERS.md) | parallel helper sub-agents |
| [`astra/MEMORY.md`](astra/MEMORY.md) | memory and history recall |
| [`astra/SKILLS.md`](astra/SKILLS.md) | bundled skills |
| [`astra/CANVAS.md`](astra/CANVAS.md) | run outcome canvas |
| [`astra/HANDOFF.md`](astra/HANDOFF.md) | delegation to external CLIs |
| [`astra/EVAL.md`](astra/EVAL.md) | eval harness port |

## Process, reports and creative

| File | Covers |
|---|---|
| [`astra/RELEASE_CHECKLIST.md`](astra/RELEASE_CHECKLIST.md) | owner items and release proofs |
| [`astra/OWNER_QUESTIONS.md`](astra/OWNER_QUESTIONS.md) | open questions for the owner |
| [`astra/PLAYWRIGHT.md`](astra/PLAYWRIGHT.md) | Playwright usage for captures |
| [`astra/FIRST_LOAD_UX_TESTCASE.md`](astra/FIRST_LOAD_UX_TESTCASE.md) | first-load UX test case |
| [`astra/E2E_AUDIT_2026-11-20.md`](astra/E2E_AUDIT_2026-11-20.md) | dated end-to-end audit (frozen) |
| [`astra/REPORT-2026-11-04.md`](astra/REPORT-2026-11-04.md) | dated native-merge report (frozen) |
| [`astra/ASTRA_FILM.md`](astra/ASTRA_FILM.md) | Astra film script (not an engineering doc) |

## Folders

| Folder | Contents |
|---|---|
| `astra/` | scope, state, decisions, dev setup and subsystem contracts |
| `astra/spikes/` | time-boxed decision spikes |
| `astra/assets/` | reference screenshots and UI captures |
| `agents/` | issue tracker, triage labels and domain-doc conventions shared by the agent skills |
| `archive/` | dated reports and superseded plans, kept for the reasoning trail |
| `planning/` | master build plan (`PLAN.md`) and native-binding merge plan (`MERGE.md`) |
| `performance/` | consolidated stress report (`STRESS_REPORT.md`) and per-run observations (`OBSERVATIONS.md`) |
| `release/` | local release/distribution notes (git-ignored working doc) |
| `notes/` | working notes such as the owner bug list (git-ignored) |
