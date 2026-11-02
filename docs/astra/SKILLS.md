# Skills (P6-T07)

25 bundled skills ported from the MPL-2.0 base snapshot
(`folder_context/...-app/skills/`, see `docs/astra/PROVENANCE.md`),
rebranded to Astra. Behavior is otherwise unchanged: these are **full ports**,
not stubs. The only content change vs the snapshot is the product-name
rebrand (`plan-my-day` referenced the old name; now "Astra tasks").
Each file gained `version:` + `triggers:` frontmatter (new fields, no
behavioral meaning to the agent beyond skill selection).

Validate with `python3 tools/skill-lint/skill_lint.py` (schema + name
uniqueness + brand-lint + link integrity). Must stay clean alongside
`bash tools/brand-lint.sh`.

## Bundled skills

| Skill | What it does | Tools it uses |
|---|---|---|
| `campaign-plan` | Plan a marketing campaign or launch: dated steps across the right channels, and the launch-day messages drafted for each channel. | [ask, start_part, web_search, create, finish] |
| `compare-and-choose` | Compare products, services, places or options and recommend one: from a store, a list the person gives, or what is best for a need. | [start_part, web_search, create, finish] |
| `competitor-landscape` | Map a product's competitors for marketing: who they are, how each positions and prices itself, how they pitch in their own words, and where the opening is. | [web_search, web_fetch, start_part, create, finish] |
| `exam-prep` | Prepare for an exam by a date: what it covers, a day-by-day revision plan up to it, past papers and the best material, and practice questions with answers. | [ask, search_notes, start_part, create, finish] |
| `explain-a-subject` | Explain how something works (a concept, a mechanism, a system, a language feature) so the person understands it. For the person's own or pasted code, use explain-code. | [create, finish] |
| `explain-code` | Explain how a piece of the person's code works (a file, a function, a flow in their repository, or code they pasted): what it does, how data moves through it, and why. | [start_part, create, finish] |
| `fix-a-bug` | Fix a bug or a failing test in the person's repository, from an issue, an error or a description: find the cause, change the code, show the tests passing. | [start_part, create, finish] |
| `inbox-triage` | Go through the person's email inbox: find what needs a reply or an action, draft the replies, and say what can be archived. For a to-do list across Slack and mail, use today-from-my-messages. | [start_part, create, finish] |
| `investor-list` | Build a list of investors who fit the person's company: funds and angels active at their stage and in their space, with recent deals, check sizes and who to reach. | [ask, start_part, create, finish] |
| `job-search` | Find open roles that fit the person, from company career pages and job boards, and shortlist the best. | [ask, start_part, web_search, create, finish] |
| `learning-path` | Build a study plan for a subject from the best free material: courses, books, lectures and exercises, week by week. For an exam on a date, use exam-prep. | [start_part, web_search, create, finish] |
| `map-a-project` | Map how a codebase fits together (its modules, how they connect, where a request enters, where to start reading) when asked for its map or architecture. What a folder holds is describe_project alone. | [describe_project, start_part, create, finish] |
| `market-map` | Map a market for a founder: its segments, the companies in each with their logos, who raised what, and where the gaps are. | [web_search, start_part, create, finish] |
| `meeting-prep` | Prepare for a meeting (the next one on the calendar, or one the person names): who is coming, the history with them, what is open, and what to raise. | [start_part, create, finish] |
| `moodboard` | Build a moodboard from a direction in words or from reference links: real images from designers' work, gathered into one visual direction. | [start_part, create, finish] |
| `plan-my-day` | Plan the person's day from their calendar, mail, messages and Astra tasks: a timed plan and a checklist, each item linked to its source. | [day_sources, list_tasks, start_part, create, finish] |
| `pricing-research` | Research how competitors price a kind of product (plans, price points, free tiers, what each plan unlocks) and recommend a price for the person's own product. | [web_search, web_fetch, create, finish] |
| `research` | Find out what is true now about a subject from current sources and give a cited answer. | [web_search, web_fetch, start_part, create, finish] |
| `review-a-change` | Review a code change (a pull request link, a branch, or the uncommitted changes in a folder): find real problems, suggest exact fixes, and draft the review comment. | [start_part, create, finish] |
| `show-what-you-can-do` | The person asks what you can do, to see your best or to be surprised, with no task named: do one striking piece of real, finished work from public sources, now. | [web_search, web_fetch, start_part, create, finish] |
| `system-design` | Design or explain a software architecture or stack, and compare providers or technologies for it. | [create, revise, web_search, finish] |
| `today-from-my-messages` | What the person needs to do today, as one to-do list from their own Slack, Gmail and other inboxes. To work through one email inbox with replies drafted, use inbox-triage. | [day_sources, list_tasks, start_part, create, finish] |
| `trip-planning` | Plan a trip end to end: where to stay, how to get there and back, entry rules, and a day-by-day plan with the total cost. | [ask, start_part, create, finish] |
| `ui-teardown` | Take apart a product's interface (one product or a few competitors): its key screens, the design moves worth taking, what it gets wrong, and how several compare. | [start_part, create, finish] |
| `weekly-status` | Write the person's or their team's weekly status from what really happened in Linear, GitHub and Slack this week: shipped, in progress, blocked, next. | [start_part, create, finish] |

## User-skill format spec

A skill is a directory `assets/skills/<name>/` containing `SKILL.md`.
User skills follow the same layout (added under the user skills dir exposed
in Settings; built-ins here are read-only in the UI).

`SKILL.md` = YAML-ish frontmatter + Markdown body:

```markdown
---
name: my-skill            # required; kebab-case; MUST match the directory name
version: 1                # required; integer >= 1; bump on behavior change
description: What this skill does in one sentence.   # required, non-empty
triggers:                 # required; >= 1 non-empty phrase the user might type
  - "plan my day"
  - "what's on today"
tools: [ask, create, finish]   # optional; tool names the skill may invoke
---
# My skill
...numbered procedure the agent follows...
```

Rules enforced by `skill-lint`:
- Required keys `name`, `version`, `description`, `triggers`; optional `tools`;
  no unknown keys.
- `name` is kebab-case, unique across all skills, and equals the directory.
- No previous-product branding anywhere in the file.
- Every relative Markdown link must resolve to an existing file.

## Loader contract (for the P6-T01 runtime)

The future agent runtime (P6-T01 crate) owns loading and execution; this is
the file-level contract it must implement:

1. **Discovery**: read `assets/skills/*/SKILL.md` at startup (bundled,
   read-only). User skills: same format, separate user-writable root that
   shadows built-ins on `name` collision (user wins; warn on collision).
2. **Parse**: split frontmatter/body exactly as `skill-lint` does
   (`---` fences; `tools:` inline `[a, b]` or `- ` list form both accepted).
   Reject files that fail `skill-lint`; fail closed (skip the skill, log).
3. **Selection**: match the user's request against `triggers` (substring,
   case-insensitive) to rank candidate skills; `description` is the tiebreak
   summary shown to the model. A skill runs only after selection — never
   auto-execute all skills.
4. **Execution**: inject the body Markdown as the system prompt section for
   the work; expose exactly the `tools:`-listed tool names for that span
   (`tools` absent = same default toolset as a no-skill turn). Skill files
   get no filesystem/network access beyond what their tools grant.
5. **Versioning**: `version` is informational for now (display + update
   checks); no migration framework yet.

## Appendix: smoke-eval notes (manual, per skill)

No runtime exists yet, so each skill gets a manual smoke check: open a Work
session with the needed grants, type the trigger, and confirm the shape of
the result. `needs` = accounts/grants required. All recorded P6-T07, 2026-11-02.

| Skill | Trigger to type | Needs | Expect |
|---|---|---|---|
| `campaign-plan` | "plan a launch campaign for my beta" | none | dated steps per channel + drafted launch-day messages |
| `compare-and-choose` | "compare these two espresso machines, which should I buy?" | none/web | side-by-side sheet + one recommendation with reasons |
| `competitor-landscape` | "map the competitors of Notion" | web | named competitors with positioning, pricing, quotes, opening |
| `exam-prep` | "help me prep for my biology final on Dec 12" | none | coverage list + day-by-day plan + practice Q&A |
| `explain-a-subject` | "explain how TCP congestion control works" | none | plain-language explanation, no code detour |
| `explain-code` | "explain what this auth middleware does" + paste/file | repo folder grant | data-flow walkthrough, no edits proposed |
| `fix-a-bug` | "fix the failing login test" | repo folder grant | cause named, minimal diff, test output quoted passing |
| `inbox-triage` | "triage my inbox" | mail grant | what needs reply/action + drafted replies + archive list |
| `investor-list` | "find seed investors for a devtools startup" | none/web | funds+angels with stage fit, recent deals, check sizes |
| `job-search` | "find senior backend roles in Berlin" | none/web | shortlist from career pages/boards with links |
| `learning-path` | "build me a study plan for Rust" | none/web | week-by-week plan of free courses/books/exercises |
| `map-a-project` | "map how this repo fits together" | repo folder grant | modules + connections + entry point + where to read first |
| `market-map` | "map the market for AI note-taking apps" | web | segments, companies, funding, gaps |
| `meeting-prep` | "prep me for my 1:1 with Ana" | calendar grant | attendees, history, open items, suggested points |
| `moodboard` | "moodboard for a calm fintech landing page" | web | gathered reference images in one visual direction |
| `plan-my-day` | "plan my day" | calendar+mail+tasks | timed plan (time ranges) + ≤15-item checklist, all sourced |
| `pricing-research` | "how do note apps price? what should I charge?" | web | competitor plans/tiers + a recommended price |
| `research` | "are e-bike subsidies still available in France?" | web | headline answer + cited figures + stated unknowns |
| `review-a-change` | "review this PR <link>" | repo/PR access | real problems + exact fixes + draft review comment |
| `show-what-you-can-do` | "show me what you can do" | none/web | one finished cited piece, no questions first, 3 follow-ups |
| `system-design` | "design the backend for a URL shortener" | none/web | architecture + provider/tech comparison |
| `today-from-my-messages` | "what do I need to do today?" | mail+chat grants | single to-do list merged across inboxes |
| `trip-planning` | "plan a 4-day trip to Lisbon in May" | none/web | stays + transport + entry rules + day plan + total cost |
| `ui-teardown` | "tear down the Linear onboarding flow" | none/web | key screens + good moves + flaws + comparison |
| `weekly-status` | "write my weekly status" | Linear/GitHub/chat grants | shipped / in progress / blocked / next from real activity |
