# Current scope — UI ONLY (read before any task)

> **Status:** active, from 2026-11-03 until the owner says otherwise.
> **Decision:** D-36 in `docs/astra/DECISIONS.md`.
> **Applies to:** every agent, every lane, every task. If another document
> contradicts this one, this one wins.

## The rule in one sentence

**We are building the UI now. Wiring the UI to the host, the core, the engine
and real data is a separate later phase — it is not missing, it is deferred on
purpose.**

## Owner bugfix exception (2026-11-03)

The owner reported a list of everyday browser failures and asked for them to
be fixed end to end. Those named surfaces — the page context menu, history,
Back/Forward, bookmarks, favicons, private and new windows, the search default,
the content colour scheme, the loading state and the keyboard command ids — are
an explicit exception to the UI-only rule above. Everything else is still
deferred, and the backlog in `STATE.md` remains a backlog. See D-37.

## What "UI only" means

In scope:

- `ui/app` — Svelte components, routes, layout, styling, tokens, motion,
  responsive behaviour, empty/loading/error states, accessibility, copy.
- `ui/shell` — only the presentation/frame pieces the UI needs to render.
- `ui/packages/bridge` — only its **mock mode** and fixtures, as the data
  source for UI work.
- Tests, goldens, screenshots and checks that verify the interface itself.

Out of scope for this phase (deferred, do **not** start):

- Rust crates, `astra-core`, sidecar transport, SQLite schema.
- Host API routes, IPC commands/events, real `astra-core` connections.
- Firefox engine patches or overlay changes whose only purpose is wiring.
- Network calls, accounts, sync, telemetry, real search providers.
- Making an unwired button perform a real action.

The backend pieces that already exist stay as they are. The UI simply does not
depend on them yet.

## How to tell a UI bug from deferred wiring

| Symptom | Verdict |
|---|---|
| Wrong spacing, colour, typography, alignment, overflow | **UI bug — fix it.** |
| Broken interaction, focus, keyboard path, animation, state transition | **UI bug — fix it.** |
| Empty list, placeholder text, "no data", mock rows, disabled action | **Expected — the UI is rendering its unwired state.** |
| Button does nothing because the command is not routed | **Expected — wiring is deferred.** |
| `unknown_command`, missing host route, null projection | **Expected — do not "fix" by adding backend code.** |
| Page looks right but the data is fake | **Correct for this phase.** |

If the UI shows the right thing for missing data, that is a pass, not a defect.

## Hard rules for agents

1. **Do not implement backend work to make the UI "work".** No new crates,
   routes, IPC commands, database tables, sidecars or engine patches.
2. **Do not invent contracts.** No new wire types, event names, command names,
   payload shapes or host methods. If a contract seems necessary, record it and
   stop.
3. **Do not treat deferred wiring as a failure.** Do not mark a UI task
   `blocked` or "incomplete" because it is not connected to real data.
4. **Do not claim end-to-end success.** Report UI work as *"UI complete,
   wiring deferred"*. Never describe the product as fully working.
5. **Do not expand scope quietly.** If a task needs backend work, write it in
   `docs/astra/STATE.md` under "Deferred wiring" (or `OWNER_QUESTIONS.md` if it
   needs an owner decision) and continue with the UI part.
6. **Verify the UI, not the stack.** Acceptance for this phase is visual,
   behavioural and accessibility evidence (screenshots, component tests,
   goldens), not a live backend round-trip.
7. **Mock data is legitimate.** `@astra/bridge` mock mode, fixtures and local
   static data are the supported inputs. Use them.

## What "later" looks like

When the owner opens the wiring phase, the work will be:

1. Route the remaining commands in the host transport.
2. Replace mock projections with real host/core data, one surface at a time.
3. Turn the deferred-wiring list in `STATE.md` into tasks with acceptance tests.
4. Only then re-open end-to-end verification.

Until that happens, the deferred list is a backlog, not a work queue.

## Reporting template

When finishing UI work, say:

```
Scope: UI only (D-36).
Done: <what the interface now does>.
Verified: <tests/screenshots/goldens>.
Deferred wiring: <what still needs a real backend, or "none">.
```

This makes the phase explicit so the next agent cannot mistake deferred wiring
for unfinished UI.
