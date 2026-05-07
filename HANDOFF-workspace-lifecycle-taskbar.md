# Handoff: Workspace Lifecycle Taskbar + Bundle Refresh

## Goal

Continue the workspace lifecycle/taskbar work in a fresh harness.

The desired UX is:

- Workspace deletion runs in the background, leaves the user on the board, greys out the card, shows a moving red progress line on the card, and streams remove-script logs in the bottom taskbar.
- Workspace lifecycle scripts (`pre`, `setup`, `select`, `remove`) stream through the bottom taskbar instead of blocking the main terminal area.
- Bundle refresh can be run explicitly before attach from both CLI and Cmd+K, so attach demos do not get stuck in the bundle refresh modal.
- Initial workspace creation/cloning should show visible progress on the workspace/card while it is being created.

## Important User Feedback

- The videos I recorded were not sufficient: one showed only the bundle refresh modal still open, so it did not prove lifecycle scripts correctly running in the bottom bar.
- User wants a video covering initial workspace cloning and the progress bar/card state while the workspace is created.
- User explicitly requested:
  - A CLI command to refresh bundles.
  - A Cmd+K UI action to refresh bundles.

## Current Worktree Warning

The worktree is dirty and contains changes beyond this immediate handoff. Do not assume every changed file belongs to this task.

Current notable untracked files:

- `src/app/react/useWorkspaceRemovalTasks.ts`
- `src/components/ScriptTerminalPanel.web.tsx`
- `src/components/WorkspaceRemovalTaskBar.web.tsx`
- `src/components/WorkspaceRemovalTaskBar.tui.tsx`
- `todo-workspace-deletion-background-tasks.md`
- `workspace-delete-taskbar-ux.html`
- `test-results/`

Current notable modified files related to this task:

- `src/app.web.tsx`
- `src/app.tui.tsx`
- `src/session/useBundleRefreshAttachFlow.ts`
- `src/commands/bundle.ts`
- `src/cli/commands/workspace.ts`
- `src/app/workspaces/commandPaletteCommands.ts`
- `src/app/shared/command-palette/commands.ts`
- `src/app/shared/command-palette/executeCommandPaletteAction.ts`
- `src/app/react/useCommandPaletteOrchestration.ts`
- `src/components/KanbanBoard.web.tsx`
- `src/components/ScriptTerminal.web.tsx`
- `src/components/WorkspaceDetailPane.web.tsx`
- `src/pages/BoardPage.web.tsx`
- remote/session protocol/backend files listed below.

Also modified but probably unrelated or pre-existing:

- `scripts/dev.ts`
- `src/core/workspace.ts`
- `src/native-addon-embed.generated.ts`
- `src/relay/registries.ts`
- `src/types/errors.ts`

Verify with `git diff` before continuing.

## What Was Implemented

### 1. Delete Request Correlation + Timeout

Files touched:

- `src/lib/remote-session/protocol.ts`
- `src/lib/remote-session/session-handler.ts`
- `src/session/backends/remote-session-backend.ts`
- `src/session/backends/local-session-backend.ts`
- `src/session/__tests__/remote-session-backend.test.ts`

Intent:

- Add `requestId` to workspace delete request/response so delete success/error can be correlated.
- Increase workspace delete timeout to 5 minutes.
- Include `workspaceId` on remove script output events.

Why:

- Long-running remove scripts were timing out and/or difficult to correlate when multiple deletes were active.

### 2. Background Delete UX

Files touched:

- `src/app.web.tsx`
- `src/components/KanbanBoard.web.tsx`
- `src/pages/BoardPage.web.tsx`
- `src/app/react/useWorkspaceRemovalTasks.ts`
- `src/components/WorkspaceRemovalTaskBar.web.tsx`
- `src/components/WorkspaceRemovalTaskBar.tui.tsx`

Intent:

- Start delete task, leave detail pane, show disabled/greyed workspace card.
- Add moving red progress line at bottom edge of deleting card.
- Show bottom taskbar task with logs for remove scripts.

Demo/proof files created in `/tmp/opencode`:

- `/tmp/opencode/workspace-delete-taskbar-demo-success.mp4`
- `/tmp/opencode/deletion-bottom-bar-proof.png`

### 3. Shared Script Terminal Panel

Files touched:

- `src/components/ScriptTerminalPanel.web.tsx`
- `src/components/ScriptTerminal.web.tsx`
- `src/components/WorkspaceRemovalTaskBar.web.tsx`

Intent:

- Extract terminal rendering into reusable `ScriptTerminalPanel`.
- Use it both for the old full-screen script terminal and the expanded bottom taskbar logs.

### 4. Lifecycle Script Taskbar

Files touched:

- `src/app.web.tsx`
- `src/app.tui.tsx`
- `src/app/react/useWorkspaceRemovalTasks.ts`
- `src/components/WorkspaceRemovalTaskBar.web.tsx`

Intent:

- Generalize removal-task model to lifecycle phases.
- Lifecycle task labels should be:
  - `pre` -> `Prepare`
  - `setup` -> `Setup`
  - `select` -> `Select`
  - `remove` -> `Remove`
- Route script output for all phases into the bottom taskbar.

Known problem:

- TUI still has two calls using old phase label `'remove-script'`; these currently fail typecheck. Replace with `'remove'` or update the phase union if that older label is still desired.

Locations:

- `src/app.tui.tsx` around lines 354 and 488.

### 5. Bundle Refresh CLI + Cmd+K Work Started

Files touched:

- `src/commands/bundle.ts`
- `src/cli/commands/workspace.ts`
- `src/session/useBundleRefreshAttachFlow.ts`
- `src/app/workspaces/commandPaletteCommands.ts`
- `src/app/shared/command-palette/commands.ts`
- `src/app/shared/command-palette/executeCommandPaletteAction.ts`
- `src/app/react/useCommandPaletteOrchestration.ts`
- `src/app.web.tsx`
- `src/app.tui.tsx`

What changed:

- Existing CLI command already exists: `gssh workspace bundle refresh --project <name> --workspace <name>`.
- I changed it so it now uses base bundle fallback by default, matching attach behavior.
- Added `--no-base-fallback` for the old workspace-only behavior.
- Added `refreshBundle(ref)` to `useBundleRefreshAttachFlow` so UI can run bundle refresh without starting attach.
- Added Cmd+K command definition: `Refresh Bundle`.
- Wired `onRefreshBundle` through command palette dispatch and into web/TUI orchestration.

Important caveat:

- This work was mid-edit when the harness became too noisy. Finish and typecheck carefully.

## Known Errors To Fix First

Run:

```bash
bun run typecheck
```

Known local errors from an earlier run were fixed:

```text
src/app.tui.tsx(354,71): error TS2345: Argument of type '"remove-script"' is not assignable...
src/app.tui.tsx(488,65): error TS2345: Argument of type '"remove-script"' is not assignable...
src/app/shared/command-palette/executeCommandPaletteAction.test.ts(...): Property 'onRefreshBundle' is missing...
```

Fixes applied:

- In `src/app.tui.tsx`, old `'remove-script'` phase arguments were replaced with `'remove'`.
- In `src/app/shared/command-palette/executeCommandPaletteAction.test.ts`, `onRefreshBundle` was added to test handlers.
- Added a small test case that `commandId: 'refresh-bundle'` calls `onRefreshBundle` for a selected workspace.

Current `bun run typecheck` status:

- No repo-local errors were reported after those fixes.
- Typecheck still fails in `node_modules/@oh-my-pi/pi-coding-agent/...` with DOM/ReadableStream type conflicts. Treat these as dependency/type-environment noise unless the next harness has a cleaner install/config.

## Verification Already Run

This command showed the CLI now sees a bundle for the demo workspace:

```bash
TMUX_LITE_SANDBOX=multi-pane bun src/index.ts workspace bundle status --project gitspace.sh --workspace demo-lifecycle-final-20260506004017
```

Output summary:

```text
Bundle Status: gitspace.sh/demo-lifecycle-final-20260506004017
Bundle: gitspace-dev
Source: workspace .gitspace/bundle.json
Onboarding steps: 6
Bundle is up to date
```

Need to run after fixing errors:

```bash
bun test src/app/shared/command-palette/executeCommandPaletteAction.test.ts
bun test src/session/__tests__/useBundleRefreshAttachFlow.test.ts
bun run typecheck
```

Already run after the local fixes:

```bash
bun test src/app/shared/command-palette/executeCommandPaletteAction.test.ts
```

Result:

```text
3 pass
0 fail
```

If dependency type noise persists, run targeted tests/build first and inspect tsconfig/node_modules settings separately.

## Demo Workspaces Created

Do not confuse these with real work:

- `pw-lifecycle-bar-demo-20260505232000`
- `pw-lifecycle-clean-demo-20260505233500`
- `pw-lifecycle-pre-demo-20260505232500`
- `demo-lifecycle-final-20260506004017`

Clean these up after demo/testing.

Workspace list command:

```bash
TMUX_LITE_SANDBOX=multi-pane bun src/index.ts workspace list --project gitspace.sh
```

Remove command example:

```bash
TMUX_LITE_SANDBOX=multi-pane bun src/index.ts workspace remove <workspace-name> --project gitspace.sh --force
```

Do not remove `multi-pane` or `browser-use`.

## Video Files Created

Stored outside repo:

- `/tmp/opencode/workspace-delete-taskbar-demo-success.mp4`
- `/tmp/opencode/workspace-lifecycle-bottom-bar-demo.mp4`
- `/tmp/opencode/lifecycle-pre-demo.mp4`
- `/tmp/opencode/lifecycle-select-phase-bottom-bar.mp4`

User feedback:

- Only one video opened in browser.
- Lifecycle video was not acceptable because bundle refresh modal was still open.
- Need a new final demo after bundle refresh can be run from CLI/Cmd+K.

## Recommended Next Steps

1. Fix type errors listed above.
2. Verify `Refresh Bundle` appears in Cmd+K and opens the bundle refresh wizard for the selected workspace without starting attach.
3. Use CLI refresh to prepare a demo workspace:

```bash
TMUX_LITE_SANDBOX=multi-pane bun src/index.ts workspace bundle refresh --project gitspace.sh --workspace <workspace>
```

4. Record a clean attach demo where the bundle modal does not appear and lifecycle scripts stream in the bottom taskbar.
5. Add/record initial workspace creation progress:
   - Start from the UI `+ New` workspace flow.
   - Ensure the pending workspace/card appears immediately.
   - Show progress line while clone/worktree creation/setup runs.
   - If no pending card exists yet, implement a `creatingWorkspaceIds`/task model similar to `deletingWorkspaceIds`.
6. Clean up demo workspaces.

## Likely Implementation Direction For Creation Progress

Current deletion UX already has a pattern:

- Track workspace IDs currently deleting.
- Pass state into `BoardPage.web.tsx` and `KanbanBoard.web.tsx`.
- Render disabled card + bottom progress line.
- Bottom taskbar owns logs/status.

For creation:

- Introduce pending create task state in `app.web.tsx` or a new hook.
- When create workspace starts, add a pending workspace placeholder/card using the requested name/status.
- Pass `creatingWorkspaceIds` or `creatingWorkspaces` into board.
- Render same progress line but with create-specific label (`creating`, `cloning`, `setup`).
- On success, replace placeholder with real workspace from `multi.listWorkspaces()`.
- On failure, mark task failed and remove or keep failed placeholder based on UX preference.

Keep this minimal; reuse existing bottom taskbar if possible.
