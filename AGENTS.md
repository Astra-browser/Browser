# Astra — agent instructions

## ⚠️ Current phase: UI + WIRING (decision D-38)

**We are building the interface and wiring it to the host/engine at the same
time. A surface is done when it works in the running browser, not when it
renders.**

Read `docs/astra/SCOPE.md` before doing anything. It is the canonical scope
contract and it overrides assumptions from older docs.

In short:

- **Do:** build the UI and the route → host module → engine path it needs.
  Every visible control must have a real caller and a real backend.
- **Do not:** leave Firefox's own menu, dialog, window, tabbox or context menu
  answering an action. Astra's UI is the only UI; suppress/replace the native
  one.
- **Do not:** treat empty states, mock data, disabled actions,
  `unknown_command`, or unrouted commands as expected. With a reachable backend,
  those are bugs.
- **Do not:** invent wire types, event names, command names or payload shapes
  beyond what a UI caller needs. Extend the generated bindings, route table and
  contract tests, and record the change.
- **Do:** keep contexts isolated (private windows record nothing; each window
  owns its model) and tear down every listener, observer, timer and retained
  page reference.
- **Verify:** contract/unit tests plus a live Marionette probe of the packaged
  dev build for anything visual, interactive or engine-backed.
- **Report** what works, how it was verified, and what is still deferred. Never
  claim a surface finished because its UI renders.

## Where to look

| Need | File |
|---|---|
| Scope contract (authoritative) | `docs/astra/SCOPE.md` |
| Task state + remaining wiring backlog | `docs/astra/STATE.md` |
| Decisions / rationale | `docs/astra/DECISIONS.md` |
| Run + rebuild the dev build | `docs/astra/DEV_SETUP.md` |
| UI implementation rules | `ui/app/AGENTS.md` |
| Master plan (background) | `docs/planning/PLAN.md` |

## Standing project rules

- Use Context7 for library/framework docs; Firecrawl for web research.
- Keep changes inside the current task's file scope; do not touch another
  agent's locked task or branch (`docs/astra/STATE.md`).
- One logical change per commit, conventional-commit prefixes.
- Never run the engine build without `--jobs 2` (OOM risk).
- Brand lint, state check and the contract suites must stay green.
