---
name: phase-journal
description: Journal workflow phases at their boundaries — declare intent at phase start, record outcome at phase end. The system snapshots goal/workflow/review state and auto-commits; you only write the narrative. Use whenever you begin or finish a distinct phase of work (per your workflow spec or plan).
---

# Phase journal

You narrate; the system snapshots. At every phase boundary:

**Starting a phase** (before the first edit of a new phase of work):

    gssh space journal phase-start --phase "<short phase name>" \
      --intent "<what you're about to do, why, and what you expect to touch>"

**Finishing a phase** (when its work is done and verified):

    gssh space journal phase-end \
      --outcome "<what actually happened — first line becomes the commit headline>" \
      --decision "<notable choice you made>" \
      --surprise "<anything unexpected>"

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
