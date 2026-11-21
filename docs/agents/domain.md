# Domain Docs

How the engineering skills consume this repo's domain documentation when
exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root (single-context layout).
- **`docs/astra/DECISIONS.md`**: the decision log. Its `D-xx` table rows are this
  repo's ADRs; read the entries that touch the area you are about to work in.
  `AGENTS.md` and `SCOPE.md` cite them by ID (for example D-38), so treat an ID
  as the canonical handle for a decision.
- **`docs/astra/SCOPE.md`** for what is in scope; it overrides older docs.

If `GLOSSARY.md` does not exist yet, proceed silently. Do not flag its absence
or suggest creating it upfront; `/domain-modeling` creates it lazily once terms
actually get resolved.

## File structure

Single-context repo:

```
/
├── GLOSSARY.md
├── docs/astra/DECISIONS.md     ← decision log (ADR store)
├── docs/astra/SCOPE.md         ← scope contract
└── ui/, crates/, overlay/, ...
```

Do not create `docs/adr/`. Decisions are appended to `docs/astra/DECISIONS.md`
as the next free `D-nn` row, with a status/notes column.

## Use the glossary's vocabulary

When output names a domain concept (issue title, refactor proposal, hypothesis,
test name), use the term as defined in `GLOSSARY.md`. Do not drift to synonyms
the glossary explicitly avoids.

If a concept is missing, that is a signal: either you are inventing language the
project does not use (reconsider) or there is a real gap (note it for
`/domain-modeling`).

## Flag decision conflicts

If output contradicts an existing decision, surface it explicitly rather than
silently overriding:

> _Contradicts D-38 (UI + wiring phase), but worth reopening because…_

Never renumber or rewrite accepted `D-xx` entries; supersede them by appending a
new one that names the old ID.
