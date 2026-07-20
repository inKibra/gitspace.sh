---
name: space-goal
description: Drive the GitSpace goal validation contract — declare artifact requirements, fulfill them, judge them, and read plain-language readiness.
---

# GitSpace Goal Validation

Use this skill when asked to author, fulfill, or judge a goal's validation contract. Whenever a goal exists for the current workspace, treat the contract as the source of truth for "done."

## Contract

- Treat the goal as: doc → required artifacts → judgment plan → fulfillment → readiness.
- Do not invent artifacts. Every attached artifact must satisfy a declared requirement.
- Every requirement carries a rubric. Read it before producing or judging evidence.
- Do not record a passing judgment without evidence in the requirement.
- Readiness is computed from required requirements only. Optional requirements never block readiness.
- The implementer reads the rubric to know what to produce. The judge reads the rubric to apply acceptance criteria.

## Vocabulary

- **Requirement**: a declared expectation with `kind`, `title`, `rubric`, `generation`, `judgment`, and `required` flag.
- **Kind**: `screenshot | video | test-output | note | file | url`.
- **Generation**: how evidence appears — `manual` (a human/agent attaches it) or `command` (a command produces it).
- **Judgment**: how evidence is judged — `human` (Pass / Needs changes / Fail with a note), `llm` (**runner NOT implemented — see below; judge it yourself with `requirement verdict`**), or `command` (a shell command applies the rubric with a structured `expect`).
- **Expect** (command judgment): `exit-zero | stdout-contains | stderr-empty | output-matches`.
- **Same-run judgment** (default for command-generated requirements): the generation run IS the judged run — `expect` is applied to its captured exit/stdout/stderr. One execution, one verdict. Never pass `--judge-command` with the same command as `--gen-command`; only pass it when a genuinely different command judges the evidence.
- **Status**: `missing | review | accepted`.
- **Readiness**: aggregate of required requirement statuses. Reads like `Ready: all required artifacts passed judgment.`
- **Slice**: a heading-anchored section of the goal doc. Ids are slugified headings, parsed at read time — `space goal doc slices` lists them. `--slice` grounds a requirement in the doc section it proves; dangling ids warn (amber), never fail.
- **Phase** (`wfPhase`): the workflow phase that OWES a requirement. Set with `--phase` at authoring (defaults to the open journal phase). The phase's gate blocks `journal phase-end` until every owed required requirement is `accepted`. Unknown phase names warn — the workflow's phase list is canonical.

## Target another goal in the chain (`--goal`)

Every verb below defaults to the **current workspace's** goal, but takes
`--goal <id | workspace name | planned workspace name | title>` to act on **any
goal in the chain** — including a *planned* goal that has no workspace yet.
That is how you author a downstream goal's contract before anyone starts it:

```sh
space goal show     --goal billing-ui          # read another goal
space goal set      --goal billing-ui --body "# Billing UI\n\n## Objective\n…"
space goal set      --goal billing-ui --file docs/billing-goal.md   # or --stdin
space goal edit     --goal billing-ui          # open in $EDITOR (--editor <cmd> to override)
space goal doc slices --goal billing-ui        # its slice ids
space goal requirement add --goal billing-ui \
  --title "Checkout screenshot" --kind screenshot --rubric "Cart totals visible" \
  --gen manual --judge human --slice objective
space goal status   --goal billing-ui          # its readiness
```

Use `space chain show` to see the chain and pick a target. Authoring a planned
goal's doc + contract up front is the intended way to plan a multi-goal block —
you do NOT need to make the goal active first.

## Authoring requirements

These examples act on the current workspace's goal; add `--goal <target>` to any
of them to author a different goal in the chain.

```sh
# Declare a manual + human requirement
space goal requirement add \
  --title "Screenshot showing the hover state" \
  --kind screenshot \
  --rubric "Hover state must show the highlighted requirement; status colors legible at a glance." \
  --gen manual \
  --judge human

# Declare a command-generated requirement. Omit --judge entirely: it defaults
# to same-run command judgment — --expect judges the generation run itself
# (auto-accepts when it passes; `review run` re-judges the latest run without
# executing the suite a second time). Do NOT repeat the command as --judge-command.
space goal requirement add \
  --title "Focused tests pass" \
  --kind test-output \
  --rubric "Suite completes with 0 failures. No skipped tests. Exit code 0." \
  --gen command --gen-command "bun test src/components/__tests__/KanbanBoard.web.test.tsx" \
  --expect exit-zero

# Only pass --judge-command when a DIFFERENT command judges the evidence
space goal requirement add \
  --title "Bundle stays under budget" \
  --kind test-output \
  --rubric "Production build succeeds and main chunk stays under 500 KB." \
  --gen command --gen-command "bun run build" \
  --judge command --judge-command "node scripts/check-bundle-size.mjs" --expect exit-zero

# Declare an LLM-judged requirement.
# WARNING: the LLM judgment runner is NOT implemented. `review run` on this
# requirement records an amber "not yet implemented" review and never accepts
# it, so the owing phase's gate stays blocked. You must close it yourself with
# `space goal requirement verdict --accept|--reject --notes "…"`. Prefer
# `--judge human` unless you specifically want the llm label; the closing
# action is identical either way.
space goal requirement add \
  --title "Video demonstrating evidence → review → readiness" \
  --kind video \
  --rubric "1–3 minute screencast covering: missing requirement, attach evidence, record review, readiness flips to ready." \
  --gen manual \
  --judge llm --model-hint claude-3.5-sonnet

# Ground a requirement in a goal-doc slice and bind it to the workflow phase
# that owes it (the phase gate then blocks phase-end until acceptance)
space goal doc slices        # list slice ids (slugified headings)
space goal requirement add \
  --title "Rails hover screenshot" \
  --kind screenshot \
  --rubric "Hover reveals the kind-grouped rail; colors match the mock." \
  --gen manual --judge human \
  --slice validation --phase "artifact rails parity"
```

List, update, reorder, reopen, remove use the same `--requirement <id|title>` selector:

```sh
space goal requirement list
space goal requirement update --requirement "Focused tests pass" --rubric "..."
space goal requirement reorder --requirement "Focused tests pass" --position 0
space goal requirement reopen --requirement "Focused tests pass"
space goal requirement remove --requirement "Focused tests pass"
```

## Fulfilling requirements

Fulfillment is requirement-scoped. The `--kind` of the artifact must match the requirement's kind.

```sh
# Manual: attach a screenshot/file by path
space goal artifact attach --requirement "Screenshot showing the hover state" --path /abs/path/to/shot.png

# Manual: attach a URL (only for URL requirements)
space goal artifact attach --requirement "Deployed preview URL" --url https://preview.example.com/pr-42

# Manual: attach a note body (--file <path> / --stdin read the body instead)
space goal artifact attach --requirement "Diff summary of routing changes" --body "Removed redundant projection; routed connectors through anchor map."

# Any attach takes --name <label> to set the artifact's display label
space goal artifact attach --requirement "Screenshot showing the hover state" \
  --path /abs/path/to/shot.png --name "Hover state, 100% zoom"

# Command-generated evidence: run the configured generation command
space goal artifact run --requirement "Focused tests pass"
```

`space goal artifact run` executes the requirement's `generation.command` in the workspace cwd, captures stdout/stderr/exit, attaches an inline `Evidence` record with `source: 'command'`. If the requirement is command-judged and the run satisfies `expect`, the run auto-records a passing review in the same step — for same-run judgments this is the whole loop.

## Judging requirements

```sh
# Run the configured judgment. COMMAND judgments only — same-run command
# judgments judge the LATEST generation run's captured output, the command is
# not re-executed. Errors if no generation run exists yet (run `artifact run`
# first). Do NOT use this for llm-judged requirements: the llm runner is
# unimplemented and only records an unavailable review (see below).
space goal review run --requirement "Focused tests pass"

# Record a human review (required for human-judged requirements).
# Optional: --score <0-100> (rejected outside that range), --created-by <name>
# as a reviewer identity label, and --file <path>/--stdin instead of --body.
space goal review record --requirement "Hover screenshot" --decision pass --body "Hover state matches the spec." --score 90 --created-by reviewer-agent
space goal review record --requirement "Hover screenshot" --decision changes --body "Status colors still hard to distinguish at 100% zoom."
space goal review record --requirement "Hover screenshot" --decision fail --body "Wrong artifact attached."

# In-phase reviewer verdict (llm/human-judged requirements): apply the rubric
# to the attached evidence and record accept/reject with grounding notes.
# Accepted status is exactly what phase gates count. --notes is mandatory.
space goal requirement verdict --requirement "Rails hover screenshot" \
  --accept --notes "Screenshot shows the kind-grouped rail on hover; colors match the mock per rubric line 1."
space goal requirement verdict --requirement "Rails hover screenshot" \
  --reject --notes "Rail is visible but ungrouped; rubric requires kind grouping."

# Optional reviewer identity label on a verdict
space goal requirement verdict --requirement "Rails hover screenshot" \
  --accept --notes "…" --created-by review-agent
```

Command-judged requirements refuse `verdict` — they auto-judge via `review run`.
Gate waives are human-only (UI button); there is no CLI waive.

### LLM-judged requirements: judge them yourself

**The LLM judgment runner is not implemented.** `space goal review run` on an
`llm` requirement records an *amber* review whose note reads "LLM judgment
runner is not yet implemented…" and sets the status to `review`. It never sets
`accepted`. Since phase gates count only `accepted`, an llm requirement left to
`review run` blocks `space journal phase-end` permanently.

The working path is to apply the rubric yourself and record the verdict:

```sh
space goal requirement verdict --requirement "<title>" --accept --notes "<what you examined, against which rubric line>"
```

This is the same command `phase-end` prints for you when it lists an owed
llm-judged requirement. `--notes` is mandatory — it is the grounding record that
stands in for the missing runner.

Decisions:
- `pass` → status becomes `accepted`.
- `changes` → status stays `review`; record what to fix.
- `fail` → status reverts to `missing`; evidence is cleared.

A note is **required** for `changes` and `fail`. A passing review without a note records `Accepted.`

## Workflow

1. Read the goal doc (`space goal show`) and the current readiness (`space goal status`).
2. If no requirements are declared, declare them first. Phrase requirements as intent ("Screenshot showing the full chain hover state"), not as storage records ("upload PNG").
3. For each missing requirement, decide between manual attachment or command generation based on what already exists in the repo.
4. After attaching/generating evidence, judge the requirement. Prefer command judgments when a check is automatable (tests, linters, exit codes). Use human judgment for taste-based artifacts (screenshots, videos, design notes). `llm` judgment is only a *label* today — its runner is unimplemented, and you close it with `requirement verdict` exactly as you would a human-judged one.
5. Re-run `space goal status` to confirm readiness. The aggregate sentence is the deliverable, not the table.

## Readiness phrasing

`space goal status` prints **four lines**, not one sentence:

```text
Validation readiness for <goal title>: <ready | not-ready | awaiting-review>
<summary sentence>
<detail — the non-zero counts, joined by " · ">
Required: N · missing: N · review: N · accepted: N
```

The **summary** (line 2) is the sentence to quote. It is exactly one of:

- `No required artifacts declared.` — author the contract.
- `Ready: all required artifacts passed judgment.` — done.
- `N requirement(s) failed review.` — fix the artifact and re-attach. Checked
  BEFORE missing, so a failed review is reported even while artifacts are also missing.
- `N required artifact(s) missing.` — produce evidence.
- `N artifact(s) attached but not judged.` — judge them.

Counts are properly pluralized (`1 required artifact missing.` /
`2 required artifacts missing.`) — the `(s)` above is shorthand, not literal
output. Quote the summary line as printed; do not paraphrase readiness as
"looks good" or "I think we're done." Use `--json` for `{goalId, readiness}`
when you need the fields rather than the prose.

## Non-goals

- The CLI does **not** expose `save artifact` or `save judgment` as standalone primitives. Everything is requirement-scoped.
- There is no global "validation commands" list anymore. Each requirement owns its generation and judgment commands.
- The goal doc is the implementer's brief, not the judge's checklist. The judge's checklist is the rubric on each requirement.
