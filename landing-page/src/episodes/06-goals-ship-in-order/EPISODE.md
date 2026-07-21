# GitSpace · Nº 06 — goals-ship-in-order (blog side)

Long-form episode on goal chains: big features don't fit in one branch, and
parallel agents make ordering harder, not easier. Chains encode the order.

## This directory

- `index.tsx` — the blog post page (default export `BlogPost`)
- `islands/` — interactive islands embedded in the post
  - `ChainBuilder.tsx` — reader composes a chain with the add-after verb;
    mono log echoes `space chain add-after --goal <id> --title "..."`;
    marking the active goal done removes its workspace and visibly binds
    the next goal (create-workspace, branched from the ancestor's HEAD);
    phase-guarded inserts refuse with the real error message
- Embedded (not owned here): `src/components/landing/ChainKanbanShot.tsx`,
  the homepage chain-lens board, reused as the second demo

## Wiring

- Route: `/blog/goals-ship-in-order` (registered in `src/app/App.tsx`)
- Copy-drift tracking: `tools/track-changes.ts` watches this directory

## Thesis

Big features don't fit in one branch; parallel agents make ordering harder.
Chains encode the order: each goal stacks on its ancestor, blocked goals
wait, the board shows the whole line at a glance. Workspaces are ephemeral
execution; the chain is the durable plan.

## Semantics (product truth — do not drift)

Source: `src/lib/tmux-lite/agents/skills/space-chain/SKILL.md` (repo root)
and `workspace-chain-kanban-ux.html` (chain-lens UX draft).

- A chain is a PLAN OVER GOALS, a linear sequence of goal ids.
- A goal holds a workspace ONLY while an agent actively works it.
- Queued chain goals are `planned · no workspace yet`.
- Merged goals' workspaces are removed; the chain keeps the goal.
- The product's top strip shows ACTIVE WORKSPACES + statuses, never chains.
- Phase ladder `plan → code → review → ship`; a descendant cannot outpace
  an ancestor; inserts/reorders are enforced (refuse, not warn).
- `space stack status` reports git-level edges: `aligned` / `needs-rebase`
  (orthogonal to phase).
