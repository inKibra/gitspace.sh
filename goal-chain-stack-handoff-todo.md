# GitSpace Goal Chains / Stack UX Handoff Todo

## Current design artifact

- Primary mockup: `workspace-chain-kanban-ux.html`
- Related prior mockup: `workspace-delete-taskbar-ux.html`
- Intent: hand off the source-agnostic, linear goal-chain/stack UX direction for implementation planning.

## Product decision summary

- Goal chains are source-agnostic. Linear is optional input, not the core model.
- MVP uses strictly linear chains only:
  - no forks
  - no parallel lanes
  - no arbitrary dependency graph editing
- A goal is not a branch. A goal is the work unit: objective, non-goals, validation, proof, and the editable goal doc that explains the work.
- Chain order is planning metadata: `Goal A → Goal B → Goal C`.
- Each goal may be assigned to a workspace, and that workspace may currently be on any branch.
- Stack validation should inspect the current branches/HEADs of adjacent goal workspaces at validation time.
- Reordering chain goals must not silently rewrite git branches.
- If goal order and current branch ancestry diverge, show a clear `needs rebase` / validation state.
- Goals need validation/proof gates, not just order. A goal should define what success means, what evidence is required, and where proof artifacts are stored/shared.

## UX in current mockup

### Kanban card affordance

- Chained workspace cards show a small `⛓` chain badge.
- On hover, chained cards also show a `⇅` rearrange affordance.
- Clicking `⇅` opens a floating `Edit chain order` panel away from the board.
- Kanban should show both workspace-backed goals and planned goals without workspaces.
- Planned goals are first-class cards with a distinct visual treatment and `Create workspace` / `Create stacked workspace` actions.

### Floating order editor

The panel shows a vertical list of chain goals/workspaces:

```text
1 billing-schema   plan
2 billing-api      code
3 billing-ui       review
4 billing-e2e      review
5 billing-polish   ship
```

Supported mock interactions:

- click row to select
- keyboard focus
- `ArrowUp` / `ArrowDown` to move selected goal
- explicit `↑` / `↓` buttons
- rows marked draggable for drag/drop UX
- `Save order`
- `Cancel`
- `Close`

### Planned goal cards

Goals without workspaces should still appear in the kanban view. Otherwise future chain work is invisible until every workspace already exists.

Card types:

```ts
type KanbanGoalItem =
  | { kind: 'workspace-backed-goal'; goalId: string; workspaceName: string; phase: WorkspacePhase }
  | { kind: 'planned-goal'; goalId: string; title: string; phase: WorkspacePhase; chainId: string; previousGoalId?: string; blockedReason?: string };
```

Planned goal card example:

```text
billing-ui                         planned
Goal 3/5 · Review
No workspace yet
Previous: billing-api
[Create stacked workspace]
```

Validation edge statuses should handle planned goals:

```text
schema → api: aligned
api → ui: not-created
ui → e2e: blocked, parent not-created
```


### Lane progression rule

Kanban lane order is enforced:

```text
Plan → Code → Review → Ship
```

Rule:

```text
A goal cannot move before an ancestor in a later kanban lane.
Same-lane ties are allowed.
```

Examples from mockup:

- `billing-ui` cannot move before `billing-api` because that would produce `Plan → Review → Code`.
- `billing-e2e` can move before `billing-ui` because both are in `Review`.
- Invalid moves are disabled and include lane-rule tooltips.

### Save behavior

Saving order changes only planning metadata.

After save, if order differs from the current branch ancestry, the mockup shows:

```text
Goal order saved; git stack unchanged. Run stack status when ready.
```

Stack status can then inspect the currently assigned workspace branches and say whether a rebase is needed.

## Git behavior decision

MVP should not auto-rebase or rewrite branches from UI reorder.

Safe MVP operations:

- reorder goal metadata
- validate adjacent goals by inspecting the current branches/HEADs of their assigned workspaces
- mark affected goals/workspaces as `needs rebase`
- create new stacked workspace from the previous goal's currently assigned workspace/branch

Safe stack guidance command:

```bash
gssh space stack status
```

`space stack status` should validate adjacent workspace ancestry and report whether the current space is the next safe one to rebase. It should not run a rebase.

Only report `you are next to rebase` when every ancestor before the current space is already aligned. Otherwise report the blocking ancestor first.

Example output:

```text
Status: needs rebase
You are next to rebase.
Suggested: git rebase <parent-branch>
```

## Suggested implementation tasks

### 1. Add goal-chain model

- Add source-agnostic goal chain state.
- Keep Linear metadata optional.
- Store one ordered `goals[]` list for MVP.
- Avoid arbitrary `dependsOn[]` until needed.

Suggested shape:

```ts
type GoalChain = {
  id: string;
  title: string;
  projectName: string;
  goals: Goal[];
};

type Goal = {
  id: string;
  title: string;
  workspaceName?: string;
  phase: 'plan' | 'code' | 'review' | 'ship';
  doc: GoalDoc;
  validation: GoalValidation;
  eval?: GoalEval;
  proof?: GoalProof[];
  sourceRefs?: SourceRef[];
};

type GoalDoc = {
  bodyMarkdown: string;
  updatedAt: string;
  updatedBy?: string;
};

type GoalValidation = {
  criteria: string[];
  requiredProof: ProofRequirement[];
  commands?: string[];
  reviewerPrompt?: string;
};

type GoalEval = {
  script?: string;
  inputs: Array<'goal-doc' | 'proof-artifacts' | 'diff-summary' | 'agent-blame-summary' | 'notes'>;
  rubric: string[];
  reportArtifactId?: string;
};
```

Goal doc conventions:

- The goal doc is the human-editable source for the goal narrative: objective, non-goals, constraints, implementation notes, validation expectations, and review instructions.
- Keep machine-readable `validation` separate so commands can reliably validate proof and run required commands.
- Goal detail view should edit the goal doc directly. Workspace detail should show the same editor when the workspace is bound to a goal; when there is no workspace yet, the goal detail view is the fallback.
- Use a plain text/markdown textarea with preview/save, not a rich document system. The important affordance is editability and version tracking, not formatting complexity.

### 2. Add goal/workspace binding state

Track which workspace is currently assigned to each goal. Do not treat the goal itself as a branch.

```ts
type GoalWorkspaceBinding = {
  goalId: string;
  workspaceName: string;
  observedBranch?: string;
  observedHead?: string;
  updatedAt: string;
};
```

Notes:

- `observedBranch` / `observedHead` are snapshots for display/debugging, not the sole source of truth.
- A workspace may switch branches; validation must re-read current git state.
- The goal chain stays stable even when workspace branches change.

### 3. Add stack validation

Validate adjacent goals in the chain by resolving their assigned workspaces and inspecting current git ancestry at validation time:

```text
Goal chain: schema → api → ui

Current workspace branches:
schema workspace: feat/billing-schema
api workspace: brad/api-redesign
ui workspace: feat/settings-ui

Check:
schema HEAD is ancestor of api HEAD? yes
api HEAD is ancestor of ui HEAD? no

Result:
schema → api: aligned
api → ui: needs rebase
```

Implementation should use actual git ancestry, e.g.:

```bash
git merge-base --is-ancestor <parent-head-or-branch> <child-head-or-branch>
```

Suggested edge status:

```ts
type ChainStackEdgeStatus = {
  parentGoalId: string;
  childGoalId: string;
  parentWorkspace?: string;
  childWorkspace?: string;
  parentBranch?: string;
  childBranch?: string;
  parentHead?: string;
  childHead?: string;
  status:
    | 'aligned'
    | 'needs-rebase'
    | 'missing-workspace'
    | 'missing-branch'
    | 'dirty-worktree'
    | 'unknown';
};
```

### 4. Add `workspace stack` primitive

Proposed command:

```bash
gssh workspace stack <name> --from <workspace> --project <project>
```

Behavior:

- resolve parent workspace
- create new branch from parent HEAD
- create worktree
- record the workspace assignment/binding for the goal, but stack validation should still inspect current branch ancestry later

### 5. Add space-bound goal/chain commands

Suggested MVP commands:

```bash
gssh space context
gssh space goal show
gssh space goal edit
gssh space goal set --file goal.md
gssh space chain show
gssh space chain add-after --title "..."
gssh space chain add-before --title "..."
gssh space chain move-before <space>
gssh space chain move-after <space>
gssh space chain create-workspace
gssh space stack status
```

### 6. Add Kanban UI integration

- Show chain badge on chained workspaces.
- Show hover `⇅` affordance.
- Open floating order editor.
- Enforce lane-order constraints.
- Save order as metadata only.
- Show git-stack unchanged / needs-rebase warning.
- Do not render always-on spaghetti lines.
- Render planned goals without workspaces as first-class kanban cards.
- Planned goal cards should show `planned`, `no workspace yet`, previous goal, blocked reason if any, and create-workspace actions.
- `gssh space chain create-workspace` / UI create should create a workspace assigned to the planned goal from the previous goal's currently assigned workspace/branch.

### 7. Add goal validation/proof/eval model

Each goal should carry an explicit validation contract:

```yaml
objective: Build the user-facing billing settings screen.
nonGoals:
  - Do not change billing persistence schema.
  - Do not add payment provider integration.
validation:
  criteria:
    - Settings page loads current settings.
    - User can save valid settings.
    - Invalid values show inline validation.
  requiredProof:
    - type: test-output
      description: Relevant UI tests pass.
    - type: video
      description: Export a short video showing load, edit, save, reload.
  commands:
    - cd web && bun run build
eval:
  script: .gitspace/evals/billing-ui.ts
  inputs:
    - goal-doc
    - proof-artifacts
    - diff-summary
    - agent-blame-summary
    - notes
  rubric:
    - User can complete the intended workflow.
    - Video demonstrates persisted state after reload.
    - No non-goals were implemented.
```

Proof examples:

```ts
type GoalProof =
  | { type: 'test-output'; command: string; artifactId?: string; observedAt: string }
  | { type: 'video'; artifactId: string; description?: string; observedAt: string }
  | { type: 'screenshot'; artifactId: string; description?: string; observedAt: string }
  | { type: 'document'; artifactId: string; description?: string; observedAt: string }
  | { type: 'url'; url: string; description?: string; observedAt: string }
  | { type: 'manual-note'; text: string; observedAt: string };

type ProofArtifact = {
  id: string;
  goalId: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;
  uploadedBy?: string;
};
```

Recommended space-bound commands:

```bash
gssh space context
gssh space goal show
gssh space goal edit
gssh space goal set --file goal.md
gssh space proof upload --type video --file ./demo.mp4
gssh space proof add-url --url https://...
gssh space proof list
gssh space proof share <proof-id> --ttl 7d
gssh space proof download <proof-id> --output ./proof.mp4
gssh space validate
gssh space validate --run
gssh space eval
gssh space eval --run
gssh space eval --proof <proof-id>
gssh space eval --report
gssh space eval --json
```

Behavior:

- `context` shows the current space's goal doc, validation, proof status, chain position, stack status, notes summary, and agent-blame status.
- `validate` answers whether required things are present and passing: required proof exists, configured commands pass, proof artifacts are readable, and checksums match when needed.
- `eval` judges the proof/artifacts against the goal's success criteria using the goal-defined eval script/rubric.
- `eval --report` should write an eval report back as a proof artifact so review has a durable result.
- `submit-review` should move Code → Review only when validation is satisfied, or after an explicit override.
- UI may suggest moving to Review after validation succeeds, but should not silently change phase without user/agent action.
- Review → Ship should require explicit review/approval or later PR-merged detection.
- Workspace detail should support proof review: show what proof exists, what is missing, and whether each proof item satisfies the goal's validation contract.
- Workspaces should also have notes that are previewable in the workspace detail panel and editable through CLI/agent workflows.
- Goal detail/workspace detail should support goal doc editing with preview/save/history metadata. If a planned goal has no workspace, open the same detail surface in goal-only mode.

### 8. Add proof artifact storage API/binding

Proof files should be first-class artifacts, not only local paths. The storage binding should support an R2-backed implementation with short-lived presigned upload/download/share access.

Suggested interface:

```ts
type CreateProofUploadRequest = {
  chainId: string;
  goalId: string;
  proofType: 'test-output' | 'video' | 'screenshot' | 'document';
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
};

type CreateProofUploadResult = {
  artifactId: string;
  storageKey: string;
  uploadUrl: string;
  expiresAt: string;
};

interface GoalProofArtifactStore {
  createUpload(request: CreateProofUploadRequest): Promise<CreateProofUploadResult>;
  completeUpload(artifactId: string): Promise<ProofArtifact>;
  createDownloadUrl(artifactId: string, options?: { ttlSeconds?: number }): Promise<string>;
  createShareUrl(artifactId: string, options?: { ttlSeconds?: number }): Promise<string>;
}
```

R2 behavior:

- The CLI asks GitSpace for a short-lived presigned upload URL scoped to one artifact key, then uploads directly to R2.
- Treat this as a signed access capability: scoped to one object, one operation, and a short expiry.
- Do not expose long-lived R2 credentials to agents or workspaces.
- Storage keys should include project/chain/goal/artifact ids, not user-provided filenames as path authority.
- Store file metadata and checksum in GitSpace goal state after upload completes.
- `proof share` should create a presigned read URL with explicit expiry for reviewers or handoff docs.
- `validate` should verify required artifact metadata exists and can be read; for high-value proofs it should also verify the recorded checksum when downloaded.


### 9. Goal/workspace detail goal-doc/proof/notes view

Goal detail is canonical. Workspace detail should reuse it when a workspace is bound to a goal. If the goal has no workspace yet, show the same detail panel in goal-only mode.

Show:

```text
Goal: Billing settings UI
Doc:
  Objective: ...
  Non-goals: ...
  Validation expectations: ...
  Review instructions: ...

Validation:
  ✓ test-output bun test ...
  ✕ video missing

Proof artifacts:
  ✓ test-output: accepted · logs.txt · checksum verified
  ✕ video: missing required demo of save/reload flow
  ? screenshot: present but not required

Eval:
  ✓ rubric passed · eval-report.md

Proof review:
  ✓ test-output: accepted
  ✕ video: missing required demo of save/reload flow

Workspace notes:
  - API contract changed after first implementation pass.
  - User asked for exported demo video as proof.

Actions:
  Edit goal doc
  Ask agent to work goal
  Ask agent to validate goal
  Run eval
  View eval report
  Ask agent to update notes
  Upload proof
  Share proof
  Review proof
  View chain
```

Goal doc editing should be available from this detail view through a simple markdown text area with preview/save. Workspace notes can still be edited through CLI/agent workflows for MVP unless the UI explicitly adds note editing later.

Suggested workspace note shape:

```ts
type WorkspaceNote = {
  id: string;
  workspaceName: string;
  goalId?: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  author?: string;
  source?: 'user' | 'agent' | 'system';
};
```

Suggested proof review shape:

```ts
type ProofReview = {
  proofId: string;
  status: 'accepted' | 'rejected' | 'needs-more-evidence';
  reviewer?: string;
  reviewedAt: string;
  notes?: string;
};
```

### 10. Agent/skill integration

GitSpace-started agents should receive goal context or know to run:

```bash
gssh space context
```

Agent-facing skill responsibilities:

- understand the goal doc before making changes
- keep implementation scoped to the active goal
- run validation commands
- collect required proof
- upload proof artifacts through CLI, not ad hoc local paths
- call `gssh space validate --run` before claiming implementation readiness
- call `gssh space eval --report` when proof artifacts need to be judged against the goal rubric
- maintain workspace notes when discoveries/change requests matter for future agents
- review proof against validation requirements instead of only checking that a file/link exists
- suggest creating the next stacked goal/workspace when the current goal is complete

Potential agent/skill commands:

```bash
gssh space context
gssh space goal show
gssh space goal edit
gssh space goal set --file goal.md
gssh space proof upload --type video --file ./demo.mp4
gssh space proof add-url --url https://...
gssh space proof list
gssh space proof share <proof-id> --ttl 7d
gssh space proof review <proof-id> --status accepted
gssh space validate
gssh space validate --run
gssh space eval
gssh space eval --run
gssh space eval --proof <proof-id>
gssh space eval --report
gssh space eval --json
gssh space notes show
gssh space notes add --body <text>
gssh space notes edit <note-id>
```

### 11. Pi-agent Space skill follow-up

Add a GitSpace/Pi-agent skill that teaches agents how to use the Space/GitSpace commands for goals, goal docs, proof artifacts, proof review, and notes.

Skill should tell agents to:

- run `gssh space context` before implementation
- read the goal doc with `gssh space goal show` before editing code
- edit the goal doc through `gssh space goal edit/set` when the user's goal, non-goals, validation, eval rubric, or review instructions change
- inspect workspace notes with `gssh space notes show`
- add/update notes for important discoveries, constraints, user requests, or validation caveats
- upload file proof with `gssh space proof upload ...`
- add external proof links with `gssh space proof add-url ...` only when the proof should remain external
- share proof with expiring signed URLs when needed for review/handoff
- review proof with `gssh space proof review ...` when acting as reviewer
- run `gssh space validate --run` before saying a goal is ready
- run `gssh space eval --report` when the goal defines an eval rubric/script
- use `gssh space chain show` to understand previous/next goals
- suggest creating the next stacked goal/workspace only after validation and eval are satisfied

This skill should be auto-injected into GitSpace-started Pi agents so agents share the same goal-doc/proof/notes workflow.


### 12. Linear skill validation requirements

The Linear planner skill should emit more than a title/order. Each generated goal should include:

- goal doc body
- objective
- non-goals
- validation criteria
- required proof
- optional commands
- eval rubric/script suggestion when success should be judged from proof artifacts
- source Linear issue refs

It should split Linear issue content into these fields explicitly so agents know what to build, what not to build, what proof is required, how proof should be judged, and what goal-doc text should be shown in the detail panel.


### 13. Linear skill follow-up

Separate from core implementation:

- Linear skill reads Linear project/issues.
- It emits source-agnostic `gitspace.goal-chain` YAML.
- It should not directly create workspaces unless explicitly approved.
- It should include a goal doc, non-goals, validation criteria, required proof, and eval rubric/script suggestions for each goal.

## Open questions for implementation

- Where should goal chain state live: project config, GitSpace global state, or exportable `.gitspace/goals/*.yml`?
- Should chain phase derive from workspace kanban lane, or should goal phase be canonical?
- Should `space stack status` compare only current branch ancestry, or also report drift from the last observed branch/head snapshot?
- Should first MVP support drag/drop, or ship keyboard/buttons first and add drag after?
- What proof types should be first-class for MVP: test output, video, screenshot, document/PDF/report, URL, manual note?
- Should `submit-review` auto-move the workspace to Review after validation, or prompt first?
- Should agents be required to run `gssh space context` before starting work in a goal workspace?
- Should workspace notes be per workspace only, or also attachable to a goal/proof item?
- Should proof review be single-reviewer, multi-reviewer, or just latest status for MVP?
- Should artifact metadata live in exportable goal state while binary proof lives in R2, and what local-dev storage should mirror R2?
- Should eval scripts run locally only, in a sandbox, or in GitSpace-managed evaluation workers for proof artifacts that require media/document processing?
- Should eval reports be mandatory proof artifacts before review, or optional unless a goal defines `eval`?
- How should planned goals without workspaces be sorted relative to workspace-backed cards in the same lane?

## Recommendation

Ready to hand off.

Implementation order:

1. `workspace stack` primitive / planned-space workspace creation.
2. Goal chain data model + `space stack status`.
3. Goal doc model + goal/workspace detail editing surface.
4. Goal validation/proof/eval model + R2 proof artifact storage binding.
5. `space context/goal/chain/stack/proof/validate/eval` commands.
6. Workspace notes + proof review commands.
7. Kanban chain badge + floating order editor.
8. Workspace/goal detail goal-doc/proof/notes preview.
9. Agent goal-doc/validation/eval/proof/notes skill.
10. Linear planner skill that emits goal-chain YAML with goal docs, validation requirements, and eval rubrics.
