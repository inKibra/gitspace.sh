---
name: space-review
description: Review GitSpace workspace changes with grounded evidence and focused verification.
---

# GitSpace Review

Use this skill when asked to review a workspace, prepare a review summary, or assess whether changes are safe to ship.

## Contract

- Start from observed repo state: changed files, relevant callsites, tests, and runtime behavior.
- Do not present compile success as correctness.
- Mark non-observed conclusions as inference.
- Prefer focused tests that cover the changed behavior.
- If a review finding depends on production semantics, cite the file/function or command output that proves it.

## Evidence to gather

- Start with changed files and diffs: `git status --short`, `git diff --stat`, and relevant `git diff` output.
- For changed exported symbols or cross-file behavior, inspect direct callers/references before judging correctness.
- Treat current file contents, command output, test output, and explicit user intent as evidence. Label everything else as inference.

## The review-thread CLI

Findings belong in review threads, not only in your prose reply. `space review`
stores threads locally in the workspace and round-trips them with GitHub PRs.

```sh
space review list --format json     # all threads (json default; --format text to scan)
```

### Attaching a finding

Pick the granularity that matches the finding:

```sh
# Hunk-level — first list hunks to get the 1-based index for the file
space review hunks src/core/goal-validation.ts --format text
space review add-hunk src/core/goal-validation.ts --index 2 \
  --reject --body "Re-executes the suite when commands drift; see string equality check."

# File-level — a finding about the file as a whole
space review add-file src/lib/processes/config.ts \
  --body "normalizeProcessDefinition validates only ports; every other field passes through unchecked."

# Line-range — a finding anchored to specific lines
space review add-line src/core/goal-validation.ts --start 807 --end 830 \
  --side RIGHT --body "runLlmJudgment never sets accepted, so the phase gate can never pass."
```

`add-hunk` carries the decision: exactly one of `--approve`, `--reject`, or
`--pending`; `--body` is optional there and is the comment attached to the
decision. `add-hunk` re-run on the same index **updates** that hunk's review
rather than adding a second one. `add-line` defaults `--side` to `RIGHT` (the
post-change side; use `LEFT` for a finding about removed lines) and `--end` to
`--start` when omitted. All three take `--json`.

### GitHub PR round-trip

```sh
space review import --pr 42    # pull existing PR review comments in as local threads
space review push  --pr 42     # submit local decisions as one formal PR review
```

Import before you start reviewing a PR that already has comments, so you do not
re-raise what a human already raised. Push only when the review is complete —
it submits a formal GitHub review, which is externally visible. Treat it as an
externally visible action: do not push unless the user asked for it.

## Workflow

1. Identify the changed files and the user's intended outcome.
2. Read affected code paths and callsites before judging behavior.
3. For review-only tasks, do not edit tests; report missing or inadequate focused coverage as a finding/recommendation.
4. When implementation is explicitly requested, add or adjust the smallest focused tests that cover changed behavior.
5. Report actionable findings with severity, reproduction conditions, and evidence — and record each one as a review thread (`add-hunk`/`add-line`/`add-file`) so it is anchored to the code, not only to your reply.
6. If no actionable issue is found, say what was inspected and what verification was not run.

## Hooks into goal validation

When the active workspace has a goal with declared requirements, your review feeds the validation contract — it does not replace it.

- If your review is the gate for a human-judged requirement, record the decision there: `space goal review record --requirement "<title>" --decision pass|changes|fail --body "<review note>"`.
- If a finding requires more evidence (e.g. a missing screenshot, a failing focused test), report it as a finding in the review AND surface the relevant requirement title so the implementer knows which contract to refulfill.
- A passing diff review does not satisfy a requirement whose `judgment.kind` is `command`. Run `space goal review run --requirement "<title>"` for those.
- **`llm` judgment is not implemented.** `space goal review run` on an llm-judged
  requirement records an amber "LLM judgment runner is not yet implemented"
  review and leaves the status at `review` — it can never reach `accepted`, so
  the owing phase's `journal phase-end` stays blocked forever. Close llm-judged
  requirements yourself by applying the rubric and recording a verdict:
  `space goal requirement verdict --requirement "<title>" --accept|--reject --notes "<grounding>"`.
- Use `space goal status` to see whether your review unblocks readiness or whether other requirements still gate the goal.
