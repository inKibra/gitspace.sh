# GitSpace · Nº 04 — the-workflow-and-the-goal (blog side)

The plan-process episode. Thesis: agents don't need more instructions; they
need a contract. State the goal once and everything derives: requirements with
rubrics (what done means), a workflow of phases (what order work happens), and
a phase journal that declares intent before the work and records outcome after.
The plan is structure both sides execute, not a doc humans hope agents read.

## This directory

- `index.tsx` — the blog post page (default export `BlogPost`)
- `islands/DeriveTheContract.tsx` — the one big interactive island:
  pick a goal (2 presets + type-in) → derivation cascades (requirement rows
  with rubrics → workflow node graph with one parallel pair → phase-journal
  strip printing phase 1's owed contract). Second beat: try `phase-end` early
  and the gate blocks it; attach evidence, the rubric accepts, `phase-end`
  records the outcome and the auto-commit headline. Footer quotes the real
  readiness sentence shape (`N required artifacts missing.`).

## Wiring

- Route: `/blog/the-workflow-and-the-goal` (registered in `src/app/App.tsx`)
- Kicker: "The agent fleet · Nº 04"
- Structure/helpers copied from `01-babysitting-agents-sucks/index.tsx`
- No hero video yet (film ep04 pending; add a `Wide` embed at the top of the
  article when `marketing/out/04-*.mp4` exists)

## Product truth (sources)

- `src/lib/tmux-lite/agents/skills/space-goal/SKILL.md` — requirements with
  rubrics, kinds, gen/judge, same-run command judgment, `wfPhase` owing,
  readiness sentence phrasing
- `src/lib/tmux-lite/agents/skills/phase-journal/SKILL.md` — phase-start prints
  the owed contract (the definition of done), `--workflow-ref` pins the phase
  to the spec location, phase-end outcome/decision/surprise, gate computed
  from requirement statuses, `--revert` for a wrong contract
- Design language: `SITE-THESIS.md` (flat black, hairlines, square corners,
  square pips, mono kickers) + `src/components/landing/ProductShots.tsx`
