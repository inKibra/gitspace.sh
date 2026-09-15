# GitSpace · Nº 03 — the-change-guide (blog side)

Code review as a build-order story. The analyzer computes the structure
(foundations → exposers → wiring → surfaces → tests); the narrator agent
writes prose per beat, grounded in the phase journal.

## This directory

- `index.tsx` — the blog post page (default export `BlogPost`)
- `islands/` — interactive islands embedded in the post
  (ChangeGuideExplorer: the one big demo)

## Wiring

- Route: `/blog/the-change-guide` (registered in `src/app/App.tsx`)
- Copy-drift tracking: `tools/track-changes.ts` watches this directory
- OG image (todo at deploy): `landing-page/public/blog/the-change-guide-og.png`

## Thesis

A diff is not a story; file-alphabetical review is why PR review hurts. The
change guide retells the change in the order it was BUILT: foundations first,
then what wires them, then what users touch, then tests. The analyzer computes
the order (`gssh space guide analyze`, beats via
`signals.beat = { component, seq, of }`); the agent narrates each beat; the
phase journal keeps the narration honest (declared intent, not reconstructed
memory). Worksheet lands in `.gitspace/artifacts/goals/*/review/analysis.json`.

## Continuity

- Story: the checkout_v2 flag removal (same change as the homepage
  `ProductShots` ask form: "Canary: api first, watch errors 10m" and the
  `checkout-flags` workspace on the board). 14 files, 4 beats.
- Distinct from Nº 02 ("Evidence, not vibes"): this post is reading the code;
  that one is judging the outcome. Both feed the homepage Review stage.

## Product truth source

`src/lib/tmux-lite/agents/skills/review-guide-narrator/SKILL.md`
