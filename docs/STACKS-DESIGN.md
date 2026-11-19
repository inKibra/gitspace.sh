# Stacks — Design Doc

How workspaces relate to each other: what a stack is, the phase rule that keeps one in order, the state each member
shows, and how the sidebar draws it. Step 1 of the stacks work (this doc); the head's stack board and tools (step 2)
and Merge with promotion (step 3) build on it.

## 1. Two kinds of relation

A workspace's relations (`WorkspaceRelationsSchema`, `protocol-workspace/src/relations.ts`) are of two kinds.

- **Stacked on** (`stackedOn`) is merge order and branch content: the workspace merges after the one it is stacked on
  and builds on its branch. It is the only relation that constrains anything.
- **Waits on** (`dependsOn`), its reverse **blocks**, and **related to** (`relatedTo`) are planning labels. They never
  block a stack, a phase change or a merge, and stacking never adds them.

`normalizeRelations` keeps the two apart: the stack parent is never also a waits-on. Before this, stacking folded the
parent into `dependsOn`; rows stored that way read back without it (`ProjectAuthorityDO.listWorkspaceRelations`), so no
migration runs.

## 2. Stacks and heads

A stack is a workspace stacked on nothing, its **head**, and every workspace stacked on it directly or through another,
its **members**. The sidebar draws every member one level under the head, depth-first, a fork's branches one after
another (`sidebar/graph.ts` `stackTree`). A head is tagged "head" once it has members. Stack loops are refused on write
(`WORKSPACE_STACK_CYCLE`).

## 3. The phase rule

A workspace is never in a later phase than the workspace it is stacked on (Plan < Code < Review < Ship). A workspace in
Review stays in Review while it fixes review feedback.

| Write | Refused when | Refusal (names the workspace in the way) |
| --- | --- | --- |
| Stack X on Y (`stackOnRefusal`) | X is further along than Y | "X can't stack on Y: X is in Review and Y only in Code. Move Y forward first, or move X back." |
| Move a member (`phaseMoveRefusal`) | past its parent | "X can't move to Review: it is stacked on Y, which is in Code. Move Y forward first, or unstack X." |
| Move a parent (`phaseMoveRefusal`) | back behind a member | "Y can't move to Plan: X is in Code and stacked on it. Move X back first, or unstack it." |

Enforcement points:

- **Relations:** `ProjectAuthorityDO.setWorkspaceRelations` → `resolveWorkspaceRelations`. Every relation write goes
  through it: the person's `workspace.setRelations` RPC, the project agent's `space_workspace setRelations`
  (`changeAgentWorkspace`), and creation from a workspace source (`createCloudWorkspace`, which also checks before it
  records the definition).
- **Phases:** `SpaceAuthorityDO.setWorkspacePhase` against `ProjectAuthorityDO.workspaceStackPhases`. Every phase change
  goes through it: the person's phase control (the `setWorkspacePhase` session command, for any workspace), the agent's
  `space_phase`, and plan approval moving to Code (`session-controls.ts`, `runtime.ts` answer path). Automations change
  phases only through an agent's `space_phase`.
- Only a *new* stack parent is checked. A stack that already breaks the rule (possible only from before it) stays; the
  project view reports it as an `ahead-of-parent` finding and the row says "ahead of its parent". Nothing is forced.
- Archived workspaces weigh nothing in the rule.

Undo needs its own guard: `workspace.setRelations` takes `expected` (the relations the writer last read) and
`setWorkspacePhase` takes `expectedPhase`; a write over a value that changed since is refused, so an Undo never takes
back someone else's change.

## 4. Stack state per member

Each stacked workspace's position against its parent is published in the project view
(`SpaceView.workspaces[].stack.position`, a `StackStatus`), read by `readCloudStackPositions`
(`account-worker/src/cloud-stack-status.ts`) from stored checkpoints and Artifacts history: no runtime opens and no
machine is asked. The same reading answers `workspace.stackStatus`.

| State | Read as |
| --- | --- |
| N behind | `parentAhead`: commits the parent has that the member lacks |
| base rewritten | `baseRewritten`: the parent's history no longer holds the commit the member was built on, and the member's still does |
| merged — restack onto *base* | `parentMerged: 'merged'`: the parent has commits of its own (its tip is past the commit it started from) and the base branch holds its tip. A parent with no commits of its own is contained in the base it came from without having merged |

"Built on" (`builtOn` in the stored comparison) starts as the merge base when a member is first compared on a parent and
moves to each later merge base while the parent's history still holds the earlier one. When the parent's history drops
it (an amend, a rebase) and the member still carries it, the base was rewritten; once the member drops it too (it was
rebased), the current merge base is what it is built on.

Comparisons are kept per workspace by the project (`stack_comparisons`) and reused while the commits and branches they
compared are unchanged, so a view read walks history only after something moved. A member whose position can't be read
(shallow history, a failing object) has none; the view never fails for it.

## 5. Restack

Restack is a hint: it changes what "behind" is measured against and never touches a branch.

- **merged — restack onto *base*:** Restack unstacks the member (`stackedOn: null`, its labels kept). Its Base line
  (`readCloudWorkspaceBase`) then measures against the base branch.
- **base rewritten:** there is no relation to change, so the state is shown and nothing more. Rebasing the branch is the
  agent's optional git step (`StackStatus.instruction` gives the command). A later step could let Restack acknowledge a
  rewrite by moving `builtOn` to the current merge base.

## 6. The sidebar

- A row: status dot, name, the "↳ on X" caption on the name line (it gives way before the name), the "head" tag; then
  phase pips, the pull request, the stack state ("3 behind", "base rewritten", "merged — restack onto main", "ahead of
  its parent" as a warning), "↑ waits on X" / "↓ blocks Y", and the last-message preview.
- Group by State and Phase draw each stack whole under its head's group; a heading counts only the workspaces whose
  own state or phase matches it, so it agrees with the filter tabs. Filters keep a stack whole while any member
  matches, the rest faded.
- The project row is the project agent's entry: the base's status dot (its colours and pulse), a semibold name on one
  line that truncates (the whole name in its title) and a faint hairline under it.
- Stack on…, Remove from stack, Restack, Waits on… and Related to… pick in the list itself: a mode bar takes the nav
  slot, rows show refusals with reasons and rings, a stack applies on click (or a drop) with a landing preview, and
  waits-on and related are a draft that Done applies. Each change shows an Undo toast.
- The phase controls (row menu and the pane header) list every phase and say why a refused one is refused before it is
  chosen.
- The Relations card has a Stack section (Stacked on, Stacked on this) and a Planning labels section (Waits on, Blocks,
  Related to).
