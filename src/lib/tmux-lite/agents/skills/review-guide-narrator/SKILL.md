---
name: review-guide-narrator
description: Write the guided review for this workspace's diff as a build-order story — the analyzer computes structure (foundations → exposers → wiring → surfaces → tests), you narrate each beat, grounded in the phase journal. Use when asked to generate or refresh the review guide.
---

# Review guide narrator

You turn a pre-analyzed diff into "the PR as a story" — the story of HOW THE
CHANGE WAS BUILT, not a file inventory. The analyzer already computed the
structure; you ONLY write prose for the clusters it marked stale.

## Process

1. `gssh space guide analyze` — builds and commits the worksheet. The base
   defaults to the project's configured base branch, but it is NOT fixed:
   `gssh space guide analyze --base <ref>` diffs against any ref. Use it when
   the review should be scoped to something other than the project base (a
   stacked parent branch, a tag, an earlier sha). Whatever you pass becomes the
   worksheet's `baseRef`, which is the ref your `git diff` reads in step 3 —
   so re-analyze rather than hand-diffing a different base.
   Add `--json` for structured output.
2. Read the worksheet the previous step wrote. It lands in the goal folder
   this workspace owns, so glob rather than hardcoding an id:
   `.gitspace/artifacts/goals/*/review/analysis.json`. Clusters arrive in READER
   ORDER; big components are pre-split into build-order beats via
   `signals.beat = { component, seq, of }` — beat 1 is the foundation layer
   (files no other changed file depends on), later beats consume earlier ones.
3. For each cluster where `stale: true`, in `order`:
   - Read its diffs: `git diff <baseRef>...HEAD -- <files>` (baseRef from the
     worksheet; only this cluster's files; summarize per-file for huge beats).
   - Read `grounding.journal` — intent/outcome written WHEN the work happened.
     Quote or paraphrase; never invent motives. Empty grounding → describe
     what the change does and mark motive-claims as uncertain.
   - Read the worksheet's top-level `goalTimeline` (goal-validation ledger:
     contract/generation/review/phase/gate events, `phase`-stamped where a
     journal phase was open) — it dates when requirements were declared,
     evidenced, and judged; use it the same way as the journal for grounding,
     and to anchor `satisfies` claims in time. GATE events are review gold:
     `gate waived: <phase>` means a human overrode an unmet gate (quote the
     reason; flag what was skipped), and `phase reverted → <target>` means the
     contract was rewritten mid-flight (narrate why per its reason — the
     definition of done changed there).
4. Write `sections.json`: `{ "headSha": <worksheet headSha>, "sections": [...],
   "specEvolution": "..." }`, then `gssh space guide submit --file sections.json`.
   Fix validation errors and resubmit — coverage of every stale cluster is
   enforced server-side.
5. `gssh space guide show` — read back the committed guide to confirm what
   landed (`--json` for the structured form). Use it to check which sections
   carried over as non-stale before re-narrating anything.

## Storytelling rules (the part that makes it a guide, not a list)

- **Beats are construction steps.** Title beat-tagged sections as steps in the
  build: "Step {seq} — {what this layer IS}" (e.g. "Step 1 — Foundations:
  types and validators", "Step 3 — Thread it through the transports").
  The explanation says what this step ADDS on top of the previous steps and
  what the next steps will do with it — forward references welcome.
- **The final-assembly beat** (often one hub file, alone in its step) gets the
  slowest-read framing: everything converges there; name the load-bearing
  structures a reviewer should check.
- **Explanation** (markdown, ≤2 short paragraphs): what the change is, then
  its consequences. Ground claims in journal quotes; cite phases in
  `cites.journalPhases`.
- **Exhibits**: files worth reading, `slow: true` only where judgment is
  required. Sweep clusters: ONE representative + a `mechanical` callout
  ("same edit × N files"). Test beats: exhibit the tests guarding the
  riskiest earlier beats.
- **Callouts**: `risk` where the journal shows struggle/surprises or a hub
  absorbs many passes; `decision` for choices a reviewer could question;
  `mechanical` for skimmable bulk (chore/docs beats).
- **Asks**: real questions only (uncertainty in the journal, choices needing
  a second opinion). Never pad.
- **`satisfies`**: requirement ids ONLY where the beat's journal delta shows
  them advancing — never decorate.

## specEvolution

If `canonTimeline` is non-empty, open with 2-4 sentences on how the
definition of done changed (which phases edited goal/rubric/workflow, and why
per journal decisions). Reviewers judge the spec before the code.

## Hard rules

- Reader order is authoritative; never reorder sections.
- Never narrate a non-stale cluster (cached prose carries over server-side).
- Exhibits must stay inside the cluster's files (validation rejects strays).
- Short. A section a reviewer can't read in a minute is a failed section.
