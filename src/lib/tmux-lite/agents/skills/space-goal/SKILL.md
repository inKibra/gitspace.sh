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
- **Judgment**: how evidence is judged — `human` (Pass / Needs changes / Fail with a note), `llm` (an LLM applies the rubric), or `command` (a shell command applies the rubric with a structured `expect`).
- **Expect** (command judgment): `exit-zero | stdout-contains | stderr-empty | output-matches`.
- **Same-run judgment** (default for command-generated requirements): the generation run IS the judged run — `expect` is applied to its captured exit/stdout/stderr. One execution, one verdict. Never pass `--judge-command` with the same command as `--gen-command`; only pass it when a genuinely different command judges the evidence.
- **Status**: `missing | review | accepted`.
- **Readiness**: aggregate of required requirement statuses. Reads like `Ready: all required artifacts passed judgment.`
- **Slice**: a heading-anchored section of the goal doc. Ids are slugified headings, parsed at read time — `space goal doc slices` lists them. `--slice` grounds a requirement in the doc section it proves; dangling ids warn (amber), never fail.
- **Phase** (`wfPhase`): the workflow phase that OWES a requirement. Set with `--phase` at authoring (defaults to the open journal phase). The phase's gate blocks `journal phase-end` until every owed required requirement is `accepted`. Unknown phase names warn — the workflow's phase list is canonical.

## Authoring requirements

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

# Declare an LLM-judged requirement
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

# Manual: attach a note body
space goal artifact attach --requirement "Diff summary of routing changes" --body "Removed redundant projection; routed connectors through anchor map."

# Command-generated evidence: run the configured generation command
space goal artifact run --requirement "Focused tests pass"
```

`space goal artifact run` executes the requirement's `generation.command` in the workspace cwd, captures stdout/stderr/exit, attaches an inline `Evidence` record with `source: 'command'`. If the requirement is command-judged and the run satisfies `expect`, the run auto-records a passing review in the same step — for same-run judgments this is the whole loop.

## Judging requirements

```sh
# Run the configured judgment (command or LLM). Same-run command judgments
# judge the LATEST generation run's captured output — the command is not
# re-executed. Errors if no generation run exists yet (run `artifact run` first).
space goal review run --requirement "Focused tests pass"

# Record a human review (required for human-judged requirements)
space goal review record --requirement "Hover screenshot" --decision pass --body "Hover state matches the spec."
space goal review record --requirement "Hover screenshot" --decision changes --body "Status colors still hard to distinguish at 100% zoom."
space goal review record --requirement "Hover screenshot" --decision fail --body "Wrong artifact attached."

# In-phase reviewer verdict (llm/human-judged requirements): apply the rubric
# to the attached evidence and record accept/reject with grounding notes.
# Accepted status is exactly what phase gates count. --notes is mandatory.
space goal requirement verdict --requirement "Rails hover screenshot" \
  --accept --notes "Screenshot shows the kind-grouped rail on hover; colors match the mock per rubric line 1."
space goal requirement verdict --requirement "Rails hover screenshot" \
  --reject --notes "Rail is visible but ungrouped; rubric requires kind grouping."
```

Command-judged requirements refuse `verdict` — they auto-judge via `review run`.
Gate waives are human-only (UI button); there is no CLI waive.

Decisions:
- `pass` → status becomes `accepted`.
- `changes` → status stays `review`; record what to fix.
- `fail` → status reverts to `missing`; evidence is cleared.

A note is **required** for `changes` and `fail`. A passing review without a note records `Accepted.`

## Workflow

1. Read the goal doc (`space goal show`) and the current readiness (`space goal status`).
2. If no requirements are declared, declare them first. Phrase requirements as intent ("Screenshot showing the full chain hover state"), not as storage records ("upload PNG").
3. For each missing requirement, decide between manual attachment or command generation based on what already exists in the repo.
4. After attaching/generating evidence, judge the requirement. Prefer command judgments when a check is automatable (tests, linters, exit codes). Use human judgment for taste-based artifacts (screenshots, videos, design notes). Use LLM judgment when the rubric is text-evaluable but you can't enumerate it (e.g. "video shows state transitions").
5. Re-run `space goal status` to confirm readiness. The aggregate sentence is the deliverable, not the table.

## Readiness phrasing

`space goal status` produces one of:

- `No required artifacts declared.` — author the contract.
- `N required artifact(s) missing.` — produce evidence.
- `N artifact(s) attached but not judged.` — judge them.
- `N requirement(s) failed review.` — fix the artifact and re-attach.
- `Ready: all required artifacts passed judgment.` — done.

Do not paraphrase readiness as "looks good" or "I think we're done." Quote the sentence.

## Non-goals

- The CLI does **not** expose `save artifact` or `save judgment` as standalone primitives. Everything is requirement-scoped.
- There is no global "validation commands" list anymore. Each requirement owns its generation and judgment commands.
- The goal doc is the implementer's brief, not the judge's checklist. The judge's checklist is the rubric on each requirement.
