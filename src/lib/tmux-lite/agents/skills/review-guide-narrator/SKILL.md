---
name: review-guide-narrator
description: Write the guided review for this workspace's diff — Linear-style sections ordered core-first, grounded in the phase journal and transcripts. Use when asked to generate or refresh the review guide.
---

# Review guide narrator

You turn a pre-analyzed diff into "the PR as a story". The analyzer already
did the structure — you ONLY write prose for the clusters it marked stale.

## Process

1. `gssh space guide analyze --base <base>` — builds and commits the worksheet.
2. Read `.gitspace/artifacts/review/analysis.json`. For each cluster where
   `stale: true`, in `order`:
   - Read its diffs: `git diff <base>...HEAD -- <files>` (only this cluster's files).
   - Read its `grounding.journal` quotes — the intent/outcome written WHEN the
     work happened. Quote or paraphrase them; do not invent motives. If
     grounding is empty, say what the change does and mark uncertain motives
     as such.
   - Write the section (shape below).
3. Write `sections.json`: `{ "headSha": <worksheet headSha>, "sections": [...],
   "specEvolution": "..." }` and run `gssh space guide submit --file sections.json`.
   Fix validation errors and resubmit — coverage of every stale cluster is enforced.

## Section shape

- `clusterId`: from the worksheet. `title`: 3-7 words, what this chapter IS.
- `explanation` (markdown): what the change is, THEN its consequences. Two
  short paragraphs max. Ground claims in journal quotes; cite phases in
  `cites.journalPhases`.
- `exhibits`: the files worth reading, `slow: true` only where judgment is
  required. For sweep clusters: ONE representative exhibit + a `mechanical`
  callout ("same edit × N files").
- `callouts`: `risk` for regions the journal shows struggle or surprises;
  `decision` for choices a reviewer could reasonably question; `mechanical`
  for skimmable bulk.
- `asks`: real questions for the reviewer (uncertainty in the journal/
  transcript, choices you'd want a second opinion on). Never pad.
- `satisfies`: requirement ids ONLY when the cluster's journal delta shows
  them advancing — do not decorate.

## specEvolution

If the worksheet's `canonTimeline` is non-empty, open with 2-4 sentences on
how the definition of done changed (which phases edited goal/rubric/workflow
and why, per journal decisions). This chapter comes first — reviewers judge
the spec before the code.

## Rules

- Reader order, not chronology. The analyzer's `order` is authoritative.
- Never narrate a non-stale cluster; the cached prose carries over.
- Exhibits must stay inside the cluster's files (validation enforces this).
- Short. A section a reviewer can't read in a minute is a failed section.
