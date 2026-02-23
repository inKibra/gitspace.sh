/**
 * gssh workspace list|add|remove|context|review|session|process|events|bundle
 *
 * --project is REQUIRED on all workspace subcommands.
 * --workspace is a required flag on review/session/process/events/bundle subcommands,
 * and a positional arg on add/remove.
 *
 * @module cli/commands/workspace
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';
import { useExplicitContext, getWorkspacePath } from '../workspace-context.js';

// ============================================================================
// Helpers
// ============================================================================

/** Add --project as requiredOption to a command. */
function requireProject(command: Command): Command {
  return command.requiredOption('--project <name>', 'Project name (required)');
}

/** Add --project and --workspace as requiredOptions to a command. */
function requireProjectAndWorkspace(command: Command): Command {
  return command
    .requiredOption('--project <name>', 'Project name (required)')
    .requiredOption('--workspace <name>', 'Workspace name (required)');
}

// ============================================================================
// Registration
// ============================================================================

export function registerWorkspaceCommands(parent: Command): void {
  const cmd = parent
    .command('workspace')
    .description('Manage workspaces within a project');

  // --------------------------------------------------------------------------
  // gssh workspace list --project <p>
  // --------------------------------------------------------------------------
  requireProject(
    cmd
      .command('list')
      .description('List workspaces in a project')
  )
    .option('--json', 'Output in JSON format')
    .option('--verbose', 'Show additional details')
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { listWorkspaces } = await import('../../commands/list.js');
      await listWorkspaces({ ...options, project: ctx.project });
    }));

  // --------------------------------------------------------------------------
  // gssh workspace add [name] --project <p>
  // --------------------------------------------------------------------------
  requireProject(
    cmd
      .command('add')
      .description('Create a new workspace')
      .argument('[workspace-name]', 'Name of the workspace to create')
  )
    .option('--branch <name>', 'Specify different branch name from workspace name')
    .option('--from <branch>', 'Create from specific branch instead of base')
    .option('--no-setup', 'Skip setup commands')
    .action(withErrorHandler(async (workspaceName, options) => {
      const ctx = useExplicitContext(options);
      const { addWorkspace } = await import('../../commands/add.js');
      await addWorkspace(workspaceName, {
        project: ctx.project,
        branchName: options.branch,
        fromBranch: options.from,
        // New CLI: never open shell (no implicit session attach)
        noShell: true,
        noSetup: options.setup === false,
      });
    }));

  // --------------------------------------------------------------------------
  // gssh workspace remove [name] --project <p>
  // --------------------------------------------------------------------------
  requireProject(
    cmd
      .command('remove')
      .description('Remove a workspace')
      .argument('[workspace-name]', 'Name of the workspace to remove')
  )
    .option('--force', 'Skip confirmation prompts')
    .option('--keep-branch', "Don't delete git branch when removing workspace")
    .action(withErrorHandler(async (workspaceName, options) => {
      const ctx = useExplicitContext(options);
      const { removeWorkspace } = await import('../../commands/remove.js');
      await removeWorkspace(workspaceName, {
        project: ctx.project,
        force: options.force,
        keepBranch: options.keepBranch,
      });
    }));

  // --------------------------------------------------------------------------
  // gssh workspace context --project <p> --workspace <w>
  // --------------------------------------------------------------------------
  requireProjectAndWorkspace(
    cmd
      .command('context')
      .description('Show resolved workspace context')
  )
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { showSpaceContext } = await import('../../commands/review.js');
      await showSpaceContext(options);
    }));

  // --------------------------------------------------------------------------
  // Review subcommands: gssh workspace review [notes|import|push|hunks|add-hunk|add-file|add-line]
  // --------------------------------------------------------------------------
  registerWorkspaceReviewCommands(cmd);

  // --------------------------------------------------------------------------
  // Session subcommands: gssh workspace session [list|new|attach]
  // --------------------------------------------------------------------------
  registerWorkspaceSessionCommands(cmd);

  // --------------------------------------------------------------------------
  // Process subcommands: gssh workspace process [list|start|stop|attach]
  // --------------------------------------------------------------------------
  registerWorkspaceProcessCommands(cmd);

  // --------------------------------------------------------------------------
  // Events subcommands: gssh workspace events [list|show|tail]
  // --------------------------------------------------------------------------
  registerWorkspaceEventsCommands(cmd);

  // --------------------------------------------------------------------------
  // Bundle subcommands: gssh workspace bundle [refresh|status]
  // --------------------------------------------------------------------------
  registerWorkspaceBundleCommands(cmd);
}

// ============================================================================
// Review
// ============================================================================

function registerWorkspaceReviewCommands(workspace: Command): void {
  const review = workspace
    .command('review')
    .description('Diff review system');

  // gssh workspace review notes --project <p> --workspace <w>
  requireProjectAndWorkspace(
    review
      .command('notes')
      .description('Print review threads as structured JSON (LLM-friendly)')
  )
    .option('--format <format>', 'Output format: json (default) or text')
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { showReviewNotes } = await import('../../commands/review.js');
      await showReviewNotes(options);
    }));

  // gssh workspace review import --project <p> --workspace <w>
  requireProjectAndWorkspace(
    review
      .command('import')
      .description('Import GitHub PR review comments as local threads')
  )
    .option('--pr <number>', 'PR number to import from', (v: string) => parseInt(v, 10))
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { importReview } = await import('../../commands/review.js');
      await importReview(options);
    }));

  // gssh workspace review push --project <p> --workspace <w>
  requireProjectAndWorkspace(
    review
      .command('push')
      .description('Push local review decisions to GitHub as a formal PR review')
  )
    .option('--pr <number>', 'PR number to submit review on', (v: string) => parseInt(v, 10))
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { pushReview } = await import('../../commands/review.js');
      await pushReview(options);
    }));

  // gssh workspace review hunks <file> --project <p> --workspace <w>
  requireProjectAndWorkspace(
    review
      .command('hunks')
      .description('List hunks in a changed file (AI-friendly target IDs)')
      .argument('<file>', 'File path')
  )
    .option('--format <format>', 'Output format: json (default) or text')
    .action(withErrorHandler(async (file, options) => {
      useExplicitContext(options);
      const { listReviewHunks } = await import('../../commands/review.js');
      await listReviewHunks(file, options);
    }));

  // gssh workspace review add-hunk <file> --project <p> --workspace <w> --index <n>
  requireProjectAndWorkspace(
    review
      .command('add-hunk')
      .description('Add or update hunk review by hunk index')
      .argument('<file>', 'File path')
  )
    .requiredOption('--index <number>', '1-based hunk index', (v: string) => parseInt(v, 10))
    .option('--body <text>', 'Optional comment body')
    .option('--approve', 'Set hunk decision to approved')
    .option('--reject', 'Set hunk decision to rejected')
    .option('--pending', 'Set hunk decision to pending')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (file, options) => {
      useExplicitContext(options);
      const { addHunkReview } = await import('../../commands/review.js');
      await addHunkReview(file, options);
    }));

  // gssh workspace review add-file <file> --project <p> --workspace <w> --body <text>
  requireProjectAndWorkspace(
    review
      .command('add-file')
      .description('Add a file-level review thread')
      .argument('<file>', 'File path')
  )
    .requiredOption('--body <text>', 'Comment body')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (file, options) => {
      useExplicitContext(options);
      const { addFileReview } = await import('../../commands/review.js');
      await addFileReview(file, options);
    }));

  // gssh workspace review add-line <file> --project <p> --workspace <w> --start <n> --body <text>
  requireProjectAndWorkspace(
    review
      .command('add-line')
      .description('Add a line-range review thread')
      .argument('<file>', 'File path')
  )
    .requiredOption('--start <number>', '1-based start line', (v: string) => parseInt(v, 10))
    .option('--end <number>', '1-based end line (defaults to start)', (v: string) => parseInt(v, 10))
    .option('--side <side>', 'LEFT or RIGHT side of diff (default: RIGHT)')
    .requiredOption('--body <text>', 'Comment body')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (file, options) => {
      useExplicitContext(options);
      const { addLineReview } = await import('../../commands/review.js');
      await addLineReview(file, options);
    }));
}

// ============================================================================
// Session
// ============================================================================

function registerWorkspaceSessionCommands(workspace: Command): void {
  const session = workspace
    .command('session')
    .description('Manage terminal sessions in a workspace');

  // gssh workspace session list --project <p> --workspace <w>
  requireProjectAndWorkspace(
    session
      .command('list')
      .description('List active sessions')
  )
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { listTmux } = await import('../../commands/tmux.js');
      await listTmux();
    }));

  // gssh workspace session new --project <p> --workspace <w>
  requireProjectAndWorkspace(
    session
      .command('new')
      .description('Create a new terminal session')
  )
    .argument('[name]', 'Session name')
    .action(withErrorHandler(async (name, options) => {
      const ctx = useExplicitContext(options);
      const { newTmux } = await import('../../commands/tmux.js');
      await newTmux(name, getWorkspacePath(ctx.project, ctx.workspace!));
    }));

  // gssh workspace session attach --project <p> --workspace <w> --session <id>
  requireProjectAndWorkspace(
    session
      .command('attach')
      .description('Attach to a terminal session')
  )
    .requiredOption('--session <id>', 'Session ID or name to attach to')
    .option('--force', 'Take over if attached elsewhere')
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { attachTmux } = await import('../../commands/tmux.js');
      await attachTmux(options.session, { force: options.force });
    }));
}

// ============================================================================
// Process
// ============================================================================

function registerWorkspaceProcessCommands(workspace: Command): void {
  const proc = workspace
    .command('process')
    .description('Manage workspace processes');

  // gssh workspace process list --project <p> --workspace <w>
  requireProjectAndWorkspace(
    proc
      .command('list')
      .description('List configured processes')
  )
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { listProcesses } = await import('../../commands/process.js');
      await listProcesses({ workspace: getWorkspacePath(ctx.project, ctx.workspace!) });
    }));

  // gssh workspace process start --project <p> --workspace <w> --name <name>
  requireProjectAndWorkspace(
    proc
      .command('start')
      .description('Start a process by name')
  )
    .requiredOption('--name <name>', 'Process name')
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { startProcess } = await import('../../commands/process.js');
      await startProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace!), name: options.name });
    }));

  // gssh workspace process stop --project <p> --workspace <w> --name <name>
  requireProjectAndWorkspace(
    proc
      .command('stop')
      .description('Stop a process by name')
  )
    .requiredOption('--name <name>', 'Process name')
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { stopProcess } = await import('../../commands/process.js');
      await stopProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace!), name: options.name });
    }));

  // gssh workspace process attach --project <p> --workspace <w> --name <name>
  requireProjectAndWorkspace(
    proc
      .command('attach')
      .description('Show attach hint for process')
  )
    .requiredOption('--name <name>', 'Process name')
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { attachProcess } = await import('../../commands/process.js');
      await attachProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace!), name: options.name });
    }));
}

// ============================================================================
// Events
// ============================================================================

function registerWorkspaceEventsCommands(workspace: Command): void {
  const events = workspace
    .command('events')
    .description('Query workspace event logs');

  // gssh workspace events list --project <p> --workspace <w>
  requireProjectAndWorkspace(
    events
      .command('list')
      .description('List events (NDJSON)')
  )
    .option('--filter <expr>', 'Filter in key=value format')
    .option('--limit <n>', 'Limit results', (v: string) => Number(v), 100)
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { listEvents } = await import('../../commands/events.js');
      await listEvents(options);
    }));

  // gssh workspace events show --project <p> --workspace <w>
  requireProjectAndWorkspace(
    events
      .command('show')
      .description('Show a single event by eventId')
  )
    .option('--filter <expr>', 'Filter in key=value format')
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { showEvent } = await import('../../commands/events.js');
      await showEvent(options);
    }));

  // gssh workspace events tail --project <p> --workspace <w>
  requireProjectAndWorkspace(
    events
      .command('tail')
      .description('Tail recent events (no follow yet)')
  )
    .option('--filter <expr>', 'Filter in key=value format')
    .option('--limit <n>', 'Limit results', (v: string) => Number(v), 50)
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { tailEvents } = await import('../../commands/events.js');
      await tailEvents(options);
    }));
}

// ============================================================================
// Bundle
// ============================================================================

function registerWorkspaceBundleCommands(workspace: Command): void {
  const bundle = workspace
    .command('bundle')
    .description('Manage bundle configuration');

  // gssh workspace bundle refresh --project <p> --workspace <w>
  requireProjectAndWorkspace(
    bundle
      .command('refresh')
      .description('Re-run bundle onboarding (keeps previous values as defaults)')
  )
    .option('--force', 'Force refresh even if no changes detected')
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { bundleRefresh } = await import('../../commands/bundle.js');
      if (!ctx.workspace) {
        throw new Error('--workspace is required for bundle refresh');
      }
      await bundleRefresh({
        project: ctx.project,
        workspace: ctx.workspace,
        force: options.force,
      });
    }));

  // gssh workspace bundle status --project <p> --workspace <w>
  requireProjectAndWorkspace(
    bundle
      .command('status')
      .description('Show bundle status')
  )
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { bundleStatus } = await import('../../commands/bundle.js');
      if (!ctx.workspace) {
        throw new Error('--workspace is required for bundle status');
      }
      await bundleStatus({
        project: ctx.project,
        workspace: ctx.workspace,
      });
    }));
}
