---
name: space-notes
description: Use GitSpace workspace notes as markdown context without confusing notes for verified facts.
---

# GitSpace Notes

Use this skill when asked to create, inspect, update, or apply workspace notes.

## Contract

- Notes are durable markdown context, not source-of-truth code evidence.
- Treat notes as leads until confirmed against current repo state, command output, or user instruction.
- Preserve user-written note structure when editing.
- Prefer short, searchable headings.
- When capturing decisions, include the reason, scope, and date if available.

## How to inspect notes

- Inside a workspace, prefer `space notes list --format json` for precise IDs and metadata.
- Outside a workspace, use `gssh workspace notes list --project <project> --workspace <workspace> --format json`.
- Use text output only for quick human scanning.

## How to create or update notes

- Use GitSpace notes commands, not direct edits to the JSON storage.
- Preserve note IDs and user-written structure when updating.
- Use stdin/body flags for markdown bodies; mark todo state with the dedicated note commands when applicable.

## Applying notes

- Classify notes as decision, todo, or lead.
- Verify factual claims against repo state or tool output before using them.
- If current evidence contradicts a note, say so and update or mark the note stale when asked.

## Good note shape

```md
# Decision: Merge managed default skills

- Scope: Pi agent session bootstrap.
- Decision: Merge GitSpace-managed skills with discovered user/project skills.
- Reason: GitSpace defaults should be present without removing user extensibility.
- Follow-up: Verify dedupe behavior when skill names collide.
```

## Hooks into goal validation

Notes complement the goal validation contract; they do not replace it.

- Use a note to draft rubric acceptance criteria *before* declaring a requirement. Once the requirement is declared, the rubric is the source of truth — keep the note as a decision trail, not a duplicate spec.
- For `note`-kind requirements, the inline body is the evidence. Attach it via `space goal artifact attach --requirement "<title>" --body "<note body>"`. Do not create a workspace note as a side channel for evidence.
- When a note records a follow-up decision that affects readiness, link the note to the requirement explicitly: include the requirement title in the note body. Use `space goal status` (not workspace notes) to determine whether the goal is ready.
