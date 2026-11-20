# Stacks — Design Doc

How workspaces relate to each other: what a stack is, the phase rule that keeps one in order, the state each member
shows, how the sidebar draws it (step 1), how a stack's head leads its stack (step 2), and how archiving a workspace
reorganizes its stack (step 3).

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
another (`sidebar/graph.ts` `stackTree`). Workspaces stacked on the same one are in **sibling order**
(`stackSiblingOrder`): furthest phase first (Ship, Review, Code, Plan), then by name, so the member right under a head
is the one that would head the stack next (§8). A head is tagged "head" once it has members. Stack loops are refused on
write (`WORKSPACE_STACK_CYCLE`).

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

## 7. A head leads its stack (step 2)

A stack's head leads its stack with the project agent's existing tools, scoped to the stack. No tool is new.

- **Head:** a workspace stacked on nothing with at least one open (not archived, not deleting) workspace stacked on it,
  directly or through another. **Its stack:** every open workspace whose stack chain reaches it, a chain through an
  archived workspace included. **A member** is any stacked workspace; it keeps a workspace agent's abilities (`list`,
  `board`, `status`, its own questions, the Base line). **The project agent** (the base workspace) keeps everything.
- `ProjectAuthorityDO.workspaceStackRole(id)` answers who a workspace is, from relation rows and definitions, at every
  call: its name, what it is stacked on, and the members of the stack it heads in stack order (`stackBelow`, the
  sidebar's own order, now in `protocol-workspace` and shared with `sidebar/graph.ts`).

### Who instructs whom

`space_workspace start`, `questions` and `answer` (`runtime-services.ts`, `leader`):

| Caller | Target | Result |
| --- | --- | --- |
| The project agent | any workspace | allowed, as before |
| A head | a member of its stack | allowed |
| A head | any other workspace | "Billing export can't start Zeta: Zeta isn't in your stack. …" |
| A member | any workspace | "Ledger can't start Invoices: members don't instruct other workspaces. …" |
| A workspace in no stack | any workspace | "Search index can't start Invoices: only a stack's head can instruct its members, …" |

Instructions so only flow down a stack: the project agent is no workspace's target, members instruct no one, and a head
reaches only workspaces stacked on it, none of which can instruct it back. No chain of starts and answers returns to the
workspace that began it, so agents can't keep each other going in a loop without a person. Automations stay the project
agent's.

### Reports go to the starter

The watch a start arms (`ProjectWatch`, `project-watch.ts`) records who sent the instruction (`from`: the base workspace
or the head; watches armed before this have none and are the project agent's). The watched turn's report goes to that
workspace's runtime (`account-runtime-host.ts` → `SpaceAuthorityDO.runtimeWorkspaceReport`, no longer base-only) with the
same text and the same `quiet`/`wake`: `wake` starts the receiver's turn from its own alarm, never inside the report
call, so the subrequest-depth rule holds for heads too. A newer instruction, from either, replaces the watch. The
instruction reads "Instruction from Billing export, the head of your stack:" where the project agent's reads
"Instruction from the project agent:".

### Answers on the head's card

A head's `answer` posts the same approval card (`project-answers.ts`) in its own conversation; the card keeps who answers
(`by`, `AskAnswerSource` in `@gitspace/blocks`) and says "Billing export (stack head) asks to answer this question for
you". Approved, each answer is recorded as `answeredBy: { by: 'stack-head', workspaceId, name, at, for }`; the member's
chat card reads "Answered by Billing export (stack head) for Ada" (`AskCards.tsx`, `askAnswererName`), the asking agent
hears "Billing export, the head of your stack, answered your question … for Ada", and a later answer is refused "(by
Billing export (stack head))".

### The stack board

A head's turns start with a stack board, by the project board's logic (`boardForTurn`, `ProjectBoardDoc`,
`BOARD_CHANGES_CHARACTERS`, `boardAfterCompaction`): a full board first, after a compaction and when the changes would
pass the budget, otherwise the lines that changed. Its rows (`stackBoard` in `runtime-services.ts`) are the stack's
members only, in stack order, each line also carrying what it is stacked on and its stack state from the step 1 position
(`readCloudStackPositions` for the members and their parents):

```
Stack board, 2026-11-19 10:00:00 UTC (2 workspaces):
- Ledger (ledger) · on Billing export · 3 behind · code · idle · since 09:40
- Invoices (invoices) · on Ledger · base rewritten · parent merged · plan · working · since 09:52
```

- A workspace that stops being a head (unstacked, merged, its members archived) reads null: no board, and its board
  state starts over, so once it heads a stack again its next turn gets a full board.
- `STACK_BOARD_INSTRUCTION` joins a head's instructions while its board state holds members. The sections render before
  the turn's board is read, so the sentence arrives from the second request of its first turn as head and leaves on the
  turn after it stops; the board message itself says what it is.
- A head also keeps its Base line, after the board.
- The project agent's board is unchanged except its order: stack by stack in the sidebar's order (`stackTree` over the
  open workspaces in `readProjectWorkspaces`), one line per workspace. `space_workspace list` reads the same order.

### When a head has members sync

The `space-chain` skill says it: a member syncs when it enters Review or before it ships, or when its Base line shows
files overlapping its own changes, and never mid-turn (queued). The head syncs itself first. Members in Plan, or in Code
without overlapping files, are left alone.

## 8. Archiving reorganizes a stack (step 3)

Archiving a workspace never leaves it the parent of an open one. In the same write that records it archived
(`ProjectAuthorityDO.commitWorkspaceLifecycle` → `restackArchived`, computed by `archiveRestack` in
`protocol-workspace`), the open workspaces stacked on it directly move; those stacked on them stay where they are.
GitSpace does no merging and asks nothing first.

| Archived | Its members move | Example |
| --- | --- | --- |
| A head (stacked on nothing, or on a workspace no longer open) | The first in sibling order is promoted: stacked on nothing, measured against the base branch, the new head (leader tools, stack board). The others move onto it | Billing export archived: "Billing emails is the head now; Billing docs is on it" |
| A member | Each moves onto its parent, in sibling order | Invoices archived: "Refunds and Receipts are on Ledger now" |
| A workspace nothing open is stacked on | Nothing changes | |

**The phase rule after a move.** Siblings are ordered furthest phase first, so the promoted head is at least as far
along as each sibling moved onto it, and a member is never further along than its old parent, which is no further along
than its own parent. The one case left is a stack that broke the rule before it (only possible from before the rule):
a workspace further along than its new parent is stacked on nothing instead, never ahead of a parent. Its own members
stay on it.

Every archive reorganizes, the person's and an MCP client's alike (agents have no archive tool): all of them run
`workspace.archive` (`runWorkspaceArchive` → `SpaceAuthorityDO.archiveWorkspace` → `commitWorkspaceLifecycle`). The
same write records the moves on the archive operation as its `restack` (`{ moved, kept }`, each move
`{ workspaceId, from, to }`), which `project.operation`, the project's operation list and the account directory carry.
A moved workspace is compared with its new parent from scratch (a stored comparison keys on its parent).

### The pill and Undo

Archive from the sidebar reports in the stack pill at once, "Archiving Billing export…", with Undo. When the archive
operation ends, the pill says what moved, from its `restack`: "Billing export archived. Billing emails is the head
now; Billing docs is on it." A failed archive shows its error instead. Undo lives as long as the pill (each rewrite
starts its time over).

Undo puts it back: `workspace.restore` with `undoArchive` (the archive operation's id). The restore queues behind the
archive when that still runs (`queueOperation`'s `after`), so an Undo clicked before the archive ended waits for it, and
then:

1. restores the workspace, as Restore does;
2. puts back the archive's moves, newest first, in one write (`ProjectAuthorityDO.undoArchiveRestack`): only a workspace
   still stacked where the archive put it moves back (compare-and-set, as the picker's Undo), through the same checks as
   any relation write. One moved, archived or deleted since, or refused by the phase rule or a stack loop, stays,
   recorded in `kept` with why.

The pill then says "Billing export restored" or "Billing export restored. Not put back: Billing docs was moved since."
Restoring later from Archived brings the workspace back alone: it keeps what it was stacked on, and its old members stay
where the archive put them.
