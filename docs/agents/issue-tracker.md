# Issue tracker: GitLab (canonical) + GitHub mirror

Issues for Astra live in GitLab `kyoiske/astra`. Use the `glab` CLI for all
reads and writes. GitHub `Astra-browser/Browser` carries a mirror of each issue
so the tracker stays visible where CI runs.

## Source of truth

- The GitLab issue number is authoritative. Reference it as `kyoiske/astra#<n>`.
- The GitHub mirror is a convenience copy. If the two disagree, GitLab wins and
  the GitHub issue is corrected, not the reverse.
- Never create a GitHub-only issue. Every GitHub issue links back to its GitLab
  original.

## Conventions

- **Create an issue**: `glab issue create --title "..." --description "..." --yes`
  then mirror it:
  `gh issue create --repo Astra-browser/Browser --title "<same title>" --body "Mirrored from GitLab: https://gitlab.com/kyoiske/astra/-/issues/<n>"`.
  Put `GitLab: kyoiske/astra#<n>` at the top of the GitHub body and
  `GitHub mirror: <url>` at the end of the GitLab description, so neither side
  is orphaned.
- **Read an issue**: `glab issue view <n>` (includes notes).
- **List issues**: `glab issue list --all`, or `glab issue list -l <label>`.
- **Comment**: `glab issue note <n> --message "..."`.
- **Apply / remove labels**: `glab issue update <n> --label "..."` /
  `--unlabel "..."`. Mirror the same label onto the GitHub issue
  (`gh issue edit <n> --repo Astra-browser/Browser --add-label "..."`).
- **Close**: `glab issue close <n>`, then close the GitHub mirror with the same
  closing explanation. On an already-closed issue, still post the comment
  explicitly rather than relying on a close-with-comment form.
- **Sub-issues and blocking**: GitLab issues are the parent/child and blocking
  graph. Record structure in the body so the mirror needs no extra objects:
  `Part of kyoiske/astra#<parent>` and `Blocked by: kyoiske/astra#<n>, #<n>`.
  A ticket is unblocked when every blocker is closed. The GitHub mirror copies
  those lines verbatim; do not rebuild the graph there.

Project resolution: `glab` infers `kyoiske/astra` from the `origin` remote when
run inside the clone; pass `-R kyoiske/astra` when running elsewhere.

File issues only into `kyoiske/astra` (and its GitHub mirror). Never file into
`mattpocock/skills` (the repo the skills come from) unless the user owns it.

## Pull requests / merge requests as a request surface

**MRs/PRs as a request surface: no.** _(Set to `yes` if this repo treats external
MRs or PRs as feature requests; `/triage` reads this flag.)_

## When a skill says "publish to the issue tracker"

Create the GitLab issue, then its GitHub mirror as above.

## When a skill says "fetch the relevant ticket"

`glab issue view <n>`, including the notes.
