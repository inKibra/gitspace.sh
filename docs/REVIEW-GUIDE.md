# Review Guide — design (locked 2026-07-06)

Linear-style guided reviews (platform-generated, core-first, glue-separated),
grounded in agent context, built on the artifacts FS. Settled with Bradley in
session; supersedes nothing — composes with docs/ARTIFACTS-FS.md.

## Semantics (settled)

- **Approve**: requires all guide sections read + all required human-gated
  requirements verdicted + **all review threads resolved**. On approve:
  record `{by, at, headSha}` (review state + goal record), advance stage
  review → ship.
- **Request changes**: composes unresolved threads + failing criteria into one
  prompt → `promptAgentSession` (followUp), stage back to code. Diffs refresh
  live as the agent commits (Linear's "iterate from the diff surface").
- Guide = **generated cache, not authored artifact**: `review/guide.json` on
  the artifacts branch, keyed by `headSha`. Regenerate when HEAD moves; only
  clusters whose content-hash changed get re-narrated (read-state survives).

## Pipeline

**Phase 0 — deterministic facts (no LLM, golden-testable).**
File table; low-signal flags (lockfiles, linguist-generated, snapshots,
formatting-only via normalized re-diff); **sweep detection** via edit-shape
signatures (op-sequence over normalized token classes, minhash near-dup, same
shape ≥3 files → one section w/ representative exhibit); **moved-code**
detection (git -M/-C + line-bag hashing; agent-blame basis rule: deleted
fragment == earlier added fragment). Import graph over changed files only;
per-file **novelty** (new exported symbols) + **centrality** (in-degree
weighted by new-symbol imports); tests→source mapping.

**Phase 1 — cluster.** Community detection, weighted edges: imports (strong),
test↔source (binding), phase-journal co-membership (strong), co-commit
affinity (at its *measured* coherence score), dir proximity (weak). Auto-type
per cluster (data-model/core/surface/tests/sweep/chore) as a prior. Stable
cluster ids from content hashes. Reading-cost estimate per cluster
(novel ≫ moved ≫ mechanical). **Coverage invariant**: every changed file in
exactly one section; unassigned goes visibly to "supporting", never dropped.

**Commit order is a scored prior, never the backbone**: informative messages
+ clean file partition + topo agreement → adopt commits as sections;
otherwise commits contribute only affinity edges. Phase-boundary auto-commits
(below) make journaled branches score high by construction.

**Phase 2 — narrate clusters in parallel** (smol role, budget ∝ signal).
Input: cluster hunks (symbol summaries if huge) + grounding (below). Output:
title, explanation (what → consequences), slow-read vs skim exhibits, risk
callouts, asks. Sweeps get one line + one exhibit.

**Phase 3 — compose.** Order: core (max novelty × centrality) → dependents in
topo order → tests attached → supporting/mechanical last. Intro from goal doc.
Opening chapter option: **"how the spec evolved"** from canon history (below).
Enforce coverage. Emit guide.json.

## Grounding (two tiers + fallback)

- **Tier 1 — edit breadcrumbs (automatic)**: server-side observer on agent
  transcript tool-call entries (write/edit/bash) appends
  `{sessionId, turnId, file, hunkRange, ts}`; buffered, flushed to artifacts
  branch as `blame/edits.jsonl` at turn/phase end. Attribution = lookup.
- **Tier 2 — phase journal (skill + CLI)**: `phase-journal` skill; agent calls
  `gssh space journal phase-start --intent` / `phase-end --outcome` at
  workflow phase boundaries, paired with auto-commit. **Agent writes the
  narrative; the system snapshots state server-side** (goal reqs statuses,
  workflow node statuses, threads open, evidence ids, stage) at start+end,
  computes **delta** (requirementsAdvanced, evidenceAdded, threadsResolved).
  Entry: `journal/NN-<phase>.json` w/ workflowRef, commit start/end shas,
  filesTouched from breadcrumbs (not self-reported).
- **Fallback** (no breadcrumbs/journal): fuzzy hunk→edit matching under
  agent-blame's evidence rules — strong signal links (exact pre-image,
  anchors+overlap), weak signal → **no edge** (never hallucinate rationale).
- Transcript excerpts are a *signal* ("what we were trying to do here"),
  not a narrative to replay. Explanations cite turn ids; guide deep-links to
  the transcript moment. Struggle (edit count, errors near a region) drives
  ⚠ callouts and reading budgets. Agent hedges → auto-extracted asks.
  Delta gives **computed `satisfies`** (reqs that actually advanced) and
  gate-motion beats ("after this chapter: 3/5 gates green").

## Canon versioning (append-only via git, not a new format)

- **Write-through**: goal doc + rubric mirror to the artifacts branch as
  `goal.md` / `rubric.json` on every change (captureArtifacts hook on the
  goal-update path). Workflow specs already live there. Git history = the
  append-only canon ledger; rollup carries it to main.
- **Journal pins**: each snapshot records
  `canon: {artifactsSha, goalDocHash, rubricHash, workflowHash}` — status
  motion vs **canon motion** are distinct delta kinds; a phase that edits the
  rubric while passing gates is visibly suspicious.
- **Judgments pin canon**: reviews record `rubricHash` at judgment time.
  Stale acceptance = accepted-at-hash ≠ current-hash → flag in rubric pane +
  Approve gate input. Pure hash comparison.

## Build order

1. Breadcrumb observer + flush (`blame/edits.jsonl`)
2. Canon write-through + `rubricHash` on Review + stale-acceptance check
3. `journal phase-start/end` CLI (state snapshot, canon pins, delta,
   auto-commit) + `phase-journal` skill
4. `analyze_review_diff` op (Phase 0/1, coverage invariant; golden tests on
   this branch's ~400-file diff)
5. Narrator fan-out + guide schema + incremental re-narration
6. ChangeGuide renders guide (mock layout stays LOCKED), persisted read-state,
   Approve / Request-changes wiring; spec-evolution chapter
