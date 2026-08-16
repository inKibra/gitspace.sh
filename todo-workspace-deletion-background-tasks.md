# TODO: Run Workspace Deletion as Background Tasks with Expandable Logs

**Suggested issue title:** `Run workspace deletion as background tasks with expandable logs`

**Scope:** Focused follow-up issue; keep separate from the multi-pane PR.

## Problem

Deleting workspaces can take too long and sometimes appears stalled because remove scripts / cleanup run in the foreground. When cleanup partially succeeds, GitSpace can leave behind nearly empty workspace directories containing untracked files, without making that final state clear.

This makes deletion feel unreliable:

- UI is blocked or dominated by script output.
- Long-running remove scripts look like a hang.
- Leftover untracked files can remain silently.
- Users cannot keep working comfortably while cleanup runs.

## Goal

Move workspace deletion into a background task model with an IDE-style bottom task/status bar.

Deletion should start promptly, run in the background, and expose logs/details only when expanded.

## UX Direction

Draft prototype:

- `workspace-delete-taskbar-ux.html`

Recommended reliable handoff location if committing the draft:

- `docs/design/workspace-delete-taskbar-ux.html`

Behavior shown in the draft:

- Main workspace/terminal remains usable.
- Bottom task bar shows active/recent background tasks.
- Collapsed bar shows current task, phase, elapsed time, and progress/status.
- Expanded panel shows:
  - task list
  - current phase
  - live remove-script output
  - explicit result state
  - preserved leftovers warning if relevant

## Required Deletion Semantics

Deletion must finish in exactly one explicit state:

- `removed`
- `failed`
- `preserved_leftovers`

Do not report success if untracked leftovers remain.

Example result shape:

```ts
type WorkspaceRemoveResult =
  | { status: 'removed' }
  | { status: 'failed'; message: string; exitCode?: number }
  | {
      status: 'preserved_leftovers';
      path: string;
      files: string[];
      reason: string;
    };
```

## Task Model

Introduce background task state, initially scoped to workspace removal:

```ts
type BackgroundTask = {
  id: string;
  kind: 'workspace-remove';
  label: string;
  workspaceId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'needs_attention';
  phase?: 'pre' | 'remove-script' | 'git-worktree-remove' | 'cleanup-leftovers';
  startedAt: number;
  completedAt?: number;
  progressLabel?: string;
  logLines: TaskLogLine[];
  result?: WorkspaceRemoveResult;
};
```

## Implementation Checklist

- [ ] Add a background task store/state model.
- [ ] Change workspace delete flow to enqueue/start a task and return UI control immediately.
- [ ] Route remove script output into task logs instead of forcing the script terminal foreground.
- [ ] Add bottom task/status bar UI.
- [ ] Add expandable task details panel.
- [ ] Make workspace removal completion explicit:
  - [ ] `removed`
  - [ ] `failed`
  - [ ] `preserved_leftovers`
- [ ] If leftovers are preserved, show path and representative file list.

## Non-goals for First Cut

- No full remote protocol rewrite unless required.
- No task persistence across app reload unless easy.
- No automatic destructive deletion of untracked leftovers unless existing confirmation already clearly authorizes it.

## Follow-up

Later, tasks should become machine-authoritative so remote clients can reconnect and still see active/recent cleanup tasks.

## Handoff Options for UX Draft

1. Attach the HTML file directly to the GitHub issue if upload works.
2. Commit it to a small design branch under `docs/design/workspace-delete-taskbar-ux.html`.
3. Paste screenshots from the opened prototype into the issue and mention the local file path.

Recommended reliable handoff:

```bash
git switch -c workspace-delete-background-task-ux develop
mkdir -p docs/design
mv workspace-delete-taskbar-ux.html docs/design/workspace-delete-taskbar-ux.html
git add docs/design/workspace-delete-taskbar-ux.html
git commit -m "Add workspace deletion taskbar UX draft"
git push -u origin workspace-delete-background-task-ux
```

Then link that branch/file in the issue.

## Note

`workspace-delete-taskbar-ux.html` is present at the repository root. Move it to `docs/design/workspace-delete-taskbar-ux.html` if using handoff option 2.
