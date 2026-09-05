# GitSpace · Nº 02 — evidence-not-vibes (blog side)

Long-form essay for the implementation-proof review stage. The marketing-side
film for this episode (ep02: amber → review → evidence → merge, per the blog
slate in `landing-page/SITE-THESIS.md`) is not cut yet; when it lands under
`marketing/video/src/episodes/`, embed it as the hero video the way Nº 01 does
and cross-link this manifest from its EPISODE.md.

## This directory

- `index.tsx` — the blog post page (default export `BlogPost`)
- `islands/` — interactive islands embedded in the post
  - `VibesVsEvidence` (demo 1): the same PR as “LGTM 👍” vs. the requirement
    table with judges, evidence chips, and the readiness sentence
  - `RunTheRubric` (demo 2): a live validation contract; command judges stream
    output and auto-accept on `expect exit-zero`, the type check fails first
    run (exit 1, stays review) with a “fix applied · re-run” affordance, the
    screenshot requirement takes attach → human review, and the footer prints
    the four-line `space goal status` output live

## Wiring

- Route: `/blog/evidence-not-vibes` (registered in `src/app/App.tsx`)
- Static assets: `landing-page/public/blog/` (og image
  `evidence-not-vibes-og.png` referenced, not yet generated)
- Copy-drift tracking: `tools/track-changes.ts` overlay loads in dev

## Thesis

“Looks good to me” is not a review when the author is a machine. Human review
doesn’t scale to a fleet; evidence does. Requirements declare what done means
before the work (kind + rubric + generation + judgment); judges attach
replayable evidence; statuses move missing → review → accepted only through
judgment; readiness is a computed sentence you can quote:
`Ready: all required artifacts passed judgment.`

Product truth source: `src/lib/tmux-lite/agents/skills/space-goal/SKILL.md`
and `space-review/SKILL.md`. Distinct from Nº 03 (the change guide): that post
is reading the code; this one is judging the outcome.
