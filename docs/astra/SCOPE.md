# Current scope — UI + wiring (read before any task)

> **Status:** active, from 2026-11-03 (owner direction).
> **Decision:** D-38 in `docs/astra/DECISIONS.md`; supersedes D-36.
> **Applies to:** every agent, every lane, every task. If another document
> contradicts this one, this one wins.

## The rule in one sentence

**Build the interface and the wiring it needs until the surface actually works
in the running browser — the UI is the source of truth, and Firefox's own UI is
never the one that answers.**

The interface phase and the wiring phase are now one phase. A surface is not
"UI complete, wiring deferred" any more: it is done when the person can use it
in the dev build.

## What is in scope

- `ui/app` — components, routes, layout, styling, tokens, motion, states,
  accessibility, responsive behaviour.
- `ui/shell` — the chrome frame, the content stage, menu/theme/window bridges,
  the content `<browser>` lifecycle.
- `ui/packages/bridge` — host-mode dispatch, route tables, event pump.
- `overlay/astra/host/**` — Host API modules, Places/Session integration,
  private-window rules, projections.
- `overlay/astra/chrome/**` and `overlay/astra/jar.mn` — packaged chrome and
  resource entry points.
- IPC commands/events and their schemas in `schemas/`, `ui/app/src/shared/ipc`,
  and the Rust registries where a UI call needs them.
- Engine overlay and patches when the only way to remove a Firefox-native
  surface (menu, dialog, window, tabbox) is an engine hook.
- Tests: contract (`tests/contract`), unit/component (`ui/app`), shell/bridge,
  and live Marionette probes against the packaged dev build.

## What is not in scope

- New product surfaces with no UI caller.
- Accounts, sync, telemetry, billing, update servers and other network work
  that no current surface uses.
- Packaging/release work (P8+) and the Windows/macOS ports.
- Rewriting the engine for its own sake. An engine patch is accepted only when
  it removes a native UI surface or provides a capability the UI is already
  using.

### Owner override: Windows 11 x64 port (D-51, 2026-11-14)

The Windows 11 x64 port and its packaging are now in scope by owner direction.
This supersedes the Windows half of the "Windows/macOS ports" and
"Packaging/release work (P8+)" exclusions; macOS remains out of scope. The
Windows build follows every hard rule below: native wiring, a real backend,
live verification on the running build, isolated contexts, and no Linux
regression. Plan and locked decisions: `docs/astra/WINDOWS_MASTER_PLAN.md`.

## Hard rules for agents

1. **Wire only what a surface uses.** No speculative Host API routes, events or
   types "for later". Every route must have a caller in `ui/**`.
2. **The Astra UI is the only UI.** Never leave a Firefox menu, dialog, window,
   tabbox or context menu answering a person's action. Suppress it and render
   the Astra surface. If an engine path can only answer natively, replace the
   path or record the blocker; do not ship both UIs.
3. **One source of truth.** The running host/engine state is the truth. Mock
   data and fixtures are for tests and standalone previews only; they must never
   stand in for a reachable backend in the dev build.
4. **Empty, mock or disabled states are bugs now** when a real backend exists
   for that surface. `unknown_command` and unrouted commands are defects to fix,
   not expected states.
5. **Do not invent wire shapes.** Extend the existing generated bindings, route
   table, schemas and contract tests. If a new shape is unavoidable, record it
   in `docs/astra/STATE.md` with the reason before using it.
6. **Contexts stay isolated.** A private window records no history, bookmarks,
   time or favicons; a second window gets its own model and its own listeners.
   Normal and private state must never be readable across the boundary.
7. **Everything you open, you close.** Every listener, observer, timer, worker
   and retained page reference has an owner and a teardown path. Menus and
   context state are bounded; nothing grows per navigation.
8. **Verify on the real build.** Unit and contract tests are necessary but not
   enough. Drive the packaged dev build over Marionette (`tools/marionette-probe`)
   for anything visual, interactive, multi-window or engine-backed, and keep the
   probe as evidence.
9. **Report honestly.** Say what works, what was verified and how, and what is
   still deferred. Never call a surface finished because its UI renders.

## Definition of done

```
Surface: <what the person can now do>
UI: <files/components>
Wiring: <route → host module → engine API>
Verified: <contract/unit counts + live Marionette result>
Teardown: <what is released, and when>
Deferred: <what still needs real work, or "none">
```

## Remaining backlog

`docs/astra/STATE.md` → "Remaining wiring" is the live backlog, not a parking
lot. Pick from it when a surface is in front of you; close a row only when the
live probe passes.
