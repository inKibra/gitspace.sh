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

## Workflow

1. Identify the changed files and the user's intended outcome.
2. Read affected code paths and callsites before judging behavior.
3. For review-only tasks, do not edit tests; report missing or inadequate focused coverage as a finding/recommendation.
4. When implementation is explicitly requested, add or adjust the smallest focused tests that cover changed behavior.
5. Report actionable findings with severity, reproduction conditions, and evidence.
6. If no actionable issue is found, say what was inspected and what verification was not run.
