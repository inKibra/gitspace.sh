# GitSpace · Nº 07 — shipped-isnt-done (blog side)

Long-form post for the operate stage of the flow. Companion surface: the
homepage OperateScene in `src/components/landing/ProcessSection.tsx` (cron
tick, rollup line, ops tiles); this post is the deep-dive.

## This directory

- `index.tsx` — the blog post page (default export `BlogPost`)
- `islands/` — interactive islands embedded in the post
  - `MorningAfter` — ops dashboard (error rate / canary / rollout / p95).
    Reader fires the `◷ cron · nightly` chip: stale tiles (updated 8h ago)
    refresh, mono line shows `data/rollout.data.json refreshed → rolled up to
    main`. Reader advances a day: error rate 0.00% → 0.41% crosses the rubric
    threshold (≤ 0.10%), tile flips amber, and the shipped goal card reopens
    (shipped → reopened · regression) with the rubric line quoted as the
    reason. The reopening beat is the money shot.
  - `PromoteRollup` — promote (`local://` draft → typed `apps/*.gssh.html`)
    then rollup (artifacts branch → main, folder arrives intact).

## Wiring

- Route: `/blog/shipped-isnt-done` (registered in `src/app/App.tsx`)
- Copy-drift tracking: `tools/track-changes.ts` watches this directory
- OG image expected at `public/blog/shipped-isnt-done-og.png` (not yet made)
- No hero video yet (Nº 01 pattern: add `marketing/out/…` embed when the film
  exists)

## Thesis

Merge is the midpoint of a goal's life. The goal's folder
(`goals/<goal-id>/`) rolls up to main and outlives the workspace; a cron
trigger (`every 1 d`, enforced `data/**` write scope) refreshes the dashboard
nobody remembers to refresh; and the rubric that gated the merge stays live
next to the fresh numbers, so production disagreeing with it reopens the
goal with context intact. Operations is the fleet's memory, not a separate
tool. Datadog is the foil (it pages well; it doesn't know what a goal is).

## Product truth sources

- `src/lib/tmux-lite/agents/skills/space-artifacts/SKILL.md` (repo root) —
  tree layout, promote, rollup, trigger contract, share links
- `AGENTS.md` — `gssh artifacts rollup|sync|status` maintainer commands
