---
name: space-chain
description: Plan and operate a stacked chain of GitSpace goals — planned vs workspace-backed, phase progression, ancestor-blocked descendants, and stack alignment.
---

# GitSpace Chain & Stack

Use this skill when asked to plan a sequence of related goals, bind goals to workspaces, advance phases, reorder a chain, or interpret stack alignment.

## Contract

- A chain is a linear sequence of goals. Each goal is either `planned` (no workspace) or `workspace-backed` (worktree exists).
- Each goal advances through `plan → code → review → ship`. A descendant cannot outpace an ancestor. Moving an ancestor backward requires a cascade.
- Stack alignment is git-level: do adjacent workspaces' HEADs form an ancestor relationship? If not, the chain is `needs-rebase`.
- Do not infer alignment from phase alone. Stack alignment and phase are orthogonal: a `code → review` adjacent pair can still be `needs-rebase` at the git level.
- `space chain` mutates the goal chain. `space stack status` reports git alignment without touching anything.

## Vocabulary

- **Chain**: an ordered list of goal ids in one project.
- **Goal status**: `planned` (lives at `.gitspace/goals/planned/<id>.json`) or `workspace-backed` (lives at `.gitspace/workspace/<name>/goal.json`).
- **Phase**: `plan | code | review | ship`. Constrained by ancestor goals.
- **Stack edge**: an adjacent pair `(parent, child)` of workspace-backed goals, with a `status` of `aligned | needs-rebase | missing-workspace | missing-branch | dirty-worktree | unknown`.
- **You are next**: the first non-aligned edge into the active goal — the agent has rebase work to do.

## Inspect the chain

```sh
# Show all goals in the active chain with phase + status
space chain show

# Show the readiness summary of the active goal
space goal status

# Show git-level alignment across the chain
space stack status
```

## Plan goals

```sh
# Add a new planned goal before/after the current workspace goal
space chain add-before --title "Wire connector hover state"
space chain add-after  --title "Capture screencast"

# Reorder: move a goal before/after another goal in the chain
space chain move-before billing-api      # move active goal before billing-api
space chain move-after  billing-schema   # move active goal after billing-schema
```

Reorder is enforced against phase: you cannot place a `code` goal before a `plan` ancestor. The CLI rejects this.

## Bind a planned goal to a workspace

```sh
# Create a workspace for the active planned goal (branches from previous goal's HEAD)
space chain create-workspace

# Or specify a different name/branch
space chain create-workspace --name billing-ui --branch feat/billing-ui
```

The new workspace branches from the previous chain goal's HEAD when one exists. Otherwise it branches from the project base. After creation:
- The goal record moves from planned storage to workspace-local storage.
- Any planned validation evidence (the artifacts dir) is moved into the workspace.
- The workspace's phase is set to the goal's phase.

## Advance phase

Phase changes go through `space goal status` / `space chain` indirectly — the workspace phase is set when the agent (or user) marks the workspace as moving forward. Constraints:

- An ancestor at phase `code` blocks a descendant from reaching `review` or `ship`.
- Moving an ancestor backward (e.g. from `review` to `plan`) requires a cascade that moves every affected descendant back too.

When asked to move a workspace backward, surface the cascade preview before applying it.

## Stack status outputs

`space stack status` returns one of these per edge:

- `aligned` — child's HEAD descends from parent's HEAD.
- `needs-rebase` — child's HEAD does not descend from parent's HEAD; child needs a rebase onto parent.
- `missing-workspace` — parent or child has no workspace yet.
- `missing-branch` — one or both workspaces could not resolve HEAD.
- `dirty-worktree` — one or both workspaces have uncommitted changes; can't compare cleanly.
- `unknown` — git did not return a deterministic answer.

Top-line `status` is the first non-aligned edge. If `youAreNext` is true, the active goal is the one to rebase next (everything before it is aligned, the incoming edge needs rebase).

## Workflow

1. `space chain show` to see the planned/backed mix and phase ladder.
2. `space stack status` to see git alignment.
3. If a planned goal is next, `space chain create-workspace` to bind it.
4. If `needs-rebase` is reported, rebase the active goal onto the ancestor's HEAD. Use the workspace's git surface; this skill does not rebase for you.
5. After rebase, re-run `space stack status` to confirm `aligned`.
6. Use the `space-goal` skill to author and fulfill the validation contract for the active goal.

## Non-goals

- This skill does not rebase, merge, or push branches. It reads the chain, mutates the chain order, and binds planned goals to workspaces. Git operations are the implementer's responsibility.
- Stack status is git-level only. It does not consider whether goal validation has passed; that's `space goal status`.
- "Ship" phase does not imply merged. It marks readiness for ship; the merge itself happens through the project's normal git workflow.
