# Astra — agent instructions

## Start here

Read `docs/astra/SCOPE.md` before changing anything: it is the scope contract and
overrides assumptions from older docs. Current work, task locks and the remaining
wiring backlog live in `docs/astra/STATE.md`. Why the code looks the way it does
is in `docs/astra/DECISIONS.md`, as numbered `D-nn` entries.

## Working rules

- Build the UI and the route → host module → engine path it needs. A surface is
  done when it works in the running browser, not when it renders.
- Astra's UI answers every action; Firefox's own menu, dialog, window, tabbox and
  context menu stay suppressed.
- Empty states, mock data, disabled actions, `unknown_command` and unrouted
  commands are bugs when a reachable backend exists.
- Extending a wire type means extending the generated bindings, the route table
  and the contract tests, then recording the change in `STATE.md` and a `D-nn`
  row.
- Keep contexts isolated (private windows record nothing; each window owns its
  model), and tear down every listener, observer, timer and retained page
  reference.
- Verify with contract/unit tests plus a live Marionette probe of the packaged
  dev build for anything visual, interactive or engine-backed.
- Report what works, how it was verified, and what is still deferred.

## Where to look

| Need | File |
|---|---|
| Scope contract (authoritative) | `docs/astra/SCOPE.md` |
| Task state, locks, wiring backlog | `docs/astra/STATE.md` |
| Decisions and rationale | `docs/astra/DECISIONS.md` |
| Run, rebuild, probe the dev build | `docs/astra/DEV_SETUP.md` |
| Test and performance gates | `docs/astra/TESTING.md` |
| Full documentation index | `docs/README.md` |
| UI implementation rules | `ui/app/AGENTS.md` |
| Engine and patch rules | `engine/AGENTS.md` |
| Issue tracker, triage labels, domain docs | `docs/agents/` |

## Standing project rules

- Use Context7 for library/framework docs; Firecrawl for web research.
- Keep changes inside the current task's file scope; do not touch another
  agent's locked task or branch (`docs/astra/STATE.md`).
- **Never delete a branch.** Leave every branch in place, local and remote,
  including merged, superseded and empty ones. Deleting is only allowed when
  the owner names that exact branch and asks for it in that turn.
- One logical change per commit, conventional-commit prefixes.
- Never run the engine build without `--jobs 2` (OOM risk).
- Brand lint, state check and the contract suites must stay green.

## Agent skills

### Issue tracker

Issues live in GitLab `kyoiske/astra` (canonical) and are mirrored to GitHub `Astra-browser/Browser`. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, label strings identical on both hosts. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` at the repo root, decisions in `docs/astra/DECISIONS.md`. See `docs/agents/domain.md`.
