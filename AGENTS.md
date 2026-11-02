# Astra — agent instructions

## ⚠️ Current phase: UI ONLY (decision D-36)

**We are building the interface now. Backend/host/core wiring is deferred on
purpose and will be connected later.**

Read `docs/astra/SCOPE.md` before doing anything. It is the canonical scope
contract and it overrides assumptions from older docs.

In short:

- **Do:** build and verify the UI — layout, components, states, styling,
  motion, accessibility, interaction, screenshots, goldens.
- **Do not:** implement Rust crates, Host API routes, IPC commands/events,
  sidecars, database schema, engine patches, or network/account work to make
  the UI "work".
- **Do not:** treat empty states, mock data, disabled actions,
  `unknown_command`, or unrouted commands as bugs. That is the expected
  unwired state.
- **Do not:** invent wire types, event names, command names or payload shapes.
  If a contract is needed, record it in `docs/astra/STATE.md` → "Deferred
  wiring" and stop.
- **Report** UI work as *"UI complete, wiring deferred"*. Never claim the
  product is fully working end-to-end.

## Where to look

| Need | File |
|---|---|
| Scope contract (authoritative) | `docs/astra/SCOPE.md` |
| Task state + deferred wiring backlog | `docs/astra/STATE.md` |
| Decisions / rationale | `docs/astra/DECISIONS.md` |
| Run + rebuild the dev build | `docs/astra/DEV_SETUP.md` |
| UI implementation rules | `ui/app/AGENTS.md` |
| Master plan (background) | `plan.md` |

## Standing project rules

- Use Context7 for library/framework docs; Firecrawl for web research.
- Keep changes inside the current task's file scope; do not touch another
  agent's locked task or branch (`docs/astra/STATE.md`).
- One logical change per commit, conventional-commit prefixes.
- Never run the engine build without `--jobs 2` (OOM risk).
- Brand lint, state check and the contract suites must stay green.
