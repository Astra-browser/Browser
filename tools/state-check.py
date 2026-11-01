#!/usr/bin/env python3
"""state-check (P0-T08): STATE.md lock-registry consistency.
- Every row has ID, status in {todo,doing,blocked,done}.
- `doing` rows must name an Agent and a Branch (the lock).
- `done` rows must have a Notes entry (evidence of completion).
- No two `doing` rows share the same worker Branch (`main` is the
  orchestrator's shared branch and may appear on many rows).
"""
import re, sys

path = "docs/astra/STATE.md"
rows = []
for line in open(path).read().splitlines():
    m = re.match(r"\|\s*(P\d+-T\d+[a-z]?)\s*\|\s*(.*?)\s*\|\s*(todo|doing|blocked|done)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|$", line)
    if m:
        rows.append(m.groups())

errors = []
if not rows:
    errors.append("no task rows found")
branches = {}
for tid, task, status, agent, branch, notes in rows:
    if status == "doing":
        if agent.strip() in ("", "—", "-"):
            errors.append(f"{tid}: doing without Agent lock")
        if branch.strip() in ("", "—", "-"):
            errors.append(f"{tid}: doing without Branch lock")
        elif branch != "main" and branch in branches:
            errors.append(f"{tid}: branch {branch} already locked by {branches[branch]}")
        else:
            branches.setdefault(branch, tid)
    if status == "done" and not notes.strip():
        errors.append(f"{tid}: done without Notes evidence")

if errors:
    print("state-check: FAILED")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print(f"state-check: clean ({len(rows)} rows, {len(branches)} locked)")
