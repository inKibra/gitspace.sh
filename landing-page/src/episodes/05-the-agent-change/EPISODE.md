# GitSpace · Nº 05 — the-agent-change (blog side)

Long-form post on agent blame: provenance by conceptual change, proof-carrying
via the phase journal.

## This directory

- `index.tsx` — the blog post page (default export `Episode05`)
- `islands/BlameExplorer.tsx` — the one big demo: a rate-limit middleware file
  where each line maps to the conceptual change that owns it
  (Introduced / Moved / Refined), with phase-journal intent quotes and an
  x-ray toggle that tints the file by concept. Line 14 stacks two entries
  (introduced, then refined after review).

## Wiring

- Route: `/blog/the-agent-change` (registered in `src/app/App.tsx`)
- Copy-drift tracking: `tools/track-changes.ts` watches this directory

## Seed material

- `docs/agent-blame.html` — product mock this episode adapts. Kept: the
  introduce/move/refine kinds and their colors (blue/orange/purple), the
  click-a-line → provenance-chain interaction, the "many changes land in one
  squashed commit" framing. Dropped: pipeline/memoization/lineage-scoring
  sections (system internals, not blog thesis).
- `src/lib/tmux-lite/agents/skills/phase-journal/SKILL.md` — intent is
  declared at phase-start BEFORE the edit; that ordering is what makes the
  blame quotes proof, not rationalization.

## Thesis

git blame answers "who typed this" and with agents the answer is always "the
agent": a dead question. The unit of provenance is the conceptual change
(introduced / moved / refined), each tied to a goal and a phase, each backed
by a journal intent quote written before the code existed.
