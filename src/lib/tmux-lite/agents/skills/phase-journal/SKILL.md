---
name: phase-journal
description: Journal workflow phases at their boundaries — declare intent at phase start, record outcome at phase end. The system snapshots goal/workflow/review state and auto-commits; you only write the narrative. Use whenever you begin or finish a distinct phase of work (per your workflow spec or plan).
---

# Phase journal

You narrate; the system snapshots. At every phase boundary:

**Starting a phase** (before the first edit of a new phase of work):

    gssh space journal phase-start --phase "<short phase name>" \
      --intent "<what you're about to do, why, and what you expect to touch>"

Use a phase name from the workspace's workflow spec (`space workflow validate`
lists them) — unknown names warn on stderr and get no gate. phase-start PRINTS
the phase's owed contract: the requirements whose `wfPhase` equals this phase
(id, rubric, generate/judge commands, slice, status). That printout is your
definition of done for the phase.

**Finishing a phase** (when its work is done and verified):

    gssh space journal phase-end \
      --outcome "<what actually happened — first line becomes the commit headline>" \
      --decision "<notable choice you made>" \
      --surprise "<anything unexpected>"

**Gates.** phase-end is BLOCKED while any owed required requirement is not
`accepted` (the gate is computed from requirement statuses — nothing to edit).
A blocked phase-end reprints the unmet contract. Your exits:

1. Produce the evidence and get it judged (`space goal artifact run/attach`,
   then `space goal review run` or `space goal requirement verdict`), then
   retry phase-end.
2. The contract itself is wrong → `gssh space journal phase-end --revert
   --reason "<why the requirements need rewriting>"`. This closes the phase
   marked REVERTED (gate stays red) and returns the workflow to plan for a
   requirement rewrite. Never use --revert to dodge work you could finish.
3. Waiving a gate is HUMAN-ONLY — a button in the goal UI. There is no CLI
   waive flag; do not ask for one, ask the human.

Rules:
- One phase open at a time; `phase-end` before the next `phase-start`.
  Check with `gssh space journal status`.
- The outcome's first line becomes the auto-commit message headline — write it
  like a commit subject. Pass `--no-commit` only if you just committed manually.
- Do NOT paste goal/requirement/workflow state into the narrative — the system
  records it automatically and computes what advanced.
- Intent is written BEFORE the work: say what you expect, honestly. The review
  guide quotes it verbatim, and mismatches between intent and outcome are
  exactly what reviewers need to see.
- If you edit the rubric or goal doc during a phase, say why in --decision;
  canon changes are flagged in the delta and reviewers will look for the reason.
