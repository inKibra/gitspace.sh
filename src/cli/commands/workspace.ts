/**
 * gssh workspace list|add|remove|context|review|notes|session|service|events|bundle
 *
 * --project is REQUIRED on all workspace subcommands.
 * --workspace is a required flag on review/session/process/events/bundle subcommands,
 * and a positional arg on add/remove.
 *
 * @module cli/commands/workspace
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';
import { configureTmuxSandbox } from '../tmux-sandbox.js';
import { useExplicitContext, getWorkspacePath } from '../workspace-context.js';
import { SpacesError } from '../../types/errors.js';

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
    .option('--status <phase>', 'Kanban phase: plan, code, review, ship (default: code)')
    .option('--no-setup', 'Skip setup commands')
    .action(withErrorHandler(async (workspaceName, options) => {
      const ctx = useExplicitContext(options);
      const phase = options.status as string | undefined;
      const validPhases = ['plan', 'code', 'review', 'ship'] as const;
      if (phase && !validPhases.includes(phase as typeof validPhases[number])) {
        throw new SpacesError(
          `Invalid status: ${phase}. Use one of: ${validPhases.join(', ')}` ,
          'USER_ERROR',
          1,
        );
      }
      const status = phase as typeof validPhases[number] | undefined;
      const { addWorkspace } = await import('../../commands/add.js');
      await addWorkspace(workspaceName, {
        project: ctx.project,
        branchName: options.branch,
        fromBranch: options.from,
        status,
        // New CLI: never open shell (no implicit session attach)
        noShell: true,
        noSetup: options.setup === false,
      });
    }));

  // --------------------------------------------------------------------------
  // gssh workspace set-phase <name> --phase <plan|code|review|ship> --project <p>
  // --------------------------------------------------------------------------
  requireProject(
    cmd
      .command('set-phase')
      .description('Set kanban phase for a workspace')
      .argument('<workspace-name>', 'Workspace name')
      .requiredOption('--phase <phase>', 'Phase: plan, code, review, ship')
  )
    .action(withErrorHandler(async (workspaceName, options) => {
      const ctx = useExplicitContext(options);
      const phase = options.phase as string;
      const validPhases = ['plan', 'code', 'review', 'ship'] as const;
      if (!validPhases.includes(phase as typeof validPhases[number])) {
        throw new SpacesError(
          `Invalid phase: ${phase}. Use one of: ${validPhases.join(', ')}`,
          'USER_ERROR',
          1
        );
      }
      const { setWorkspacePhase } = await import('../../lib/tmux-lite/cli.js');
      await setWorkspacePhase(ctx.project, workspaceName, phase as typeof validPhases[number]);
      const { logger } = await import('../../utils/logger.js');
      logger.success(`Workspace ${workspaceName} set to phase: ${phase}`);
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
  // Review subcommands: gssh workspace review [list|import|push|hunks|add-hunk|add-file|add-line]
  // --------------------------------------------------------------------------
  registerWorkspaceReviewCommands(cmd);

  // --------------------------------------------------------------------------
  // Notes subcommands: gssh workspace notes [...]
  // --------------------------------------------------------------------------
  registerWorkspaceNotesCommands(cmd);

  // --------------------------------------------------------------------------
  // Session subcommands: gssh workspace session [list|new|attach]
  // --------------------------------------------------------------------------
  registerWorkspaceSessionCommands(cmd);

  // --------------------------------------------------------------------------
  // Service subcommands: gssh workspace service [list|start|stop|attach|open]
  // --------------------------------------------------------------------------
  registerWorkspaceServiceCommands(cmd);

  // --------------------------------------------------------------------------
  // Events subcommands: gssh workspace events [list|show|tail]
  // --------------------------------------------------------------------------
  registerWorkspaceEventsCommands(cmd);

  // --------------------------------------------------------------------------
  // Bundle subcommands: gssh workspace bundle [refresh|status|show|edit]
  // --------------------------------------------------------------------------
  registerWorkspaceBundleCommands(cmd);
}

function registerWorkspaceNotesCommands(workspace: Command): void {
  const notes = workspace
    .command('notes')
    .description('Manage local workspace notes and todos');

  requireProjectAndWorkspace(notes.command('list').description('List workspace notes'))
    .option('--format <format>', 'Output format: json (default) or text')
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { listNotes } = await import('../../commands/notes.js');
      await listNotes(options);
    }));

  requireProjectAndWorkspace(notes.command('add').description('Add a workspace note'))
    .option('--body <text>', 'Note body')
    .option('--stdin', 'Read note body from stdin')
    .option('--todo', 'Add as todo')
    .option('--priority <priority>', 'Todo priority: low, medium, high')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { addNote } = await import('../../commands/notes.js');
      await addNote(options);
    }));

  requireProjectAndWorkspace(notes.command('update').description('Update a workspace note'))
    .requiredOption('--id <id>', 'Note id')
    .option('--body <text>', 'New body')
    .option('--todo', 'Convert to todo')
    .option('--note', 'Convert to note')
    .option('--priority <priority>', 'Todo priority: low, medium, high')
    .option('--done', 'Mark todo done')
    .option('--undone', 'Mark todo open')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { updateNote } = await import('../../commands/notes.js');
      await updateNote(options);
    }));

  requireProjectAndWorkspace(notes.command('remove').description('Remove a workspace note'))
    .requiredOption('--id <id>', 'Note id')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { removeNote } = await import('../../commands/notes.js');
      await removeNote(options);
    }));

  requireProjectAndWorkspace(notes.command('done').description('Mark a todo done'))
    .requiredOption('--id <id>', 'Note id')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { markNoteDone } = await import('../../commands/notes.js');
      await markNoteDone(options);
    }));

  requireProjectAndWorkspace(notes.command('undone').description('Mark a todo open'))
    .requiredOption('--id <id>', 'Note id')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { markNoteUndone } = await import('../../commands/notes.js');
      await markNoteUndone(options);
    }));
}

// ============================================================================
// Review
// ============================================================================

function registerWorkspaceReviewCommands(workspace: Command): void {
  const review = workspace
    .command('review')
    .description('Diff review system');

  // gssh workspace review list --project <p> --workspace <w>
  requireProjectAndWorkspace(
    review
      .command('list')
      .description('Print review threads as structured JSON (LLM-friendly)')
  )
    .option('--format <format>', 'Output format: json (default) or text')
    .action(withErrorHandler(async (options) => {
      useExplicitContext(options);
      const { showReviewList } = await import('../../commands/review.js');
      await showReviewList(options);
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
  configureTmuxSandbox(session);

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
// Service
// ============================================================================

function registerWorkspaceServiceCommands(workspace: Command): void {
  const service = workspace
    .command('service')
    .description('Manage workspace services');

  // gssh workspace service list --project <p> --workspace <w>
  requireProjectAndWorkspace(
    service
      .command('list')
      .description('List configured services')
  )
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { listProcesses } = await import('../../commands/process.js');
      await listProcesses({ workspace: getWorkspacePath(ctx.project, ctx.workspace!) });
    }));

  // gssh workspace service start --project <p> --workspace <w> --name <name>
  requireProjectAndWorkspace(
    service
      .command('start')
      .description('Start a service by name')
  )
    .requiredOption('--name <name>', 'Service name')
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { startProcess } = await import('../../commands/process.js');
      await startProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace!), name: options.name });
    }));

  // gssh workspace service stop --project <p> --workspace <w> --name <name>
  requireProjectAndWorkspace(
    service
      .command('stop')
      .description('Stop a service by name')
  )
    .requiredOption('--name <name>', 'Service name')
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { stopProcess } = await import('../../commands/process.js');
      await stopProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace!), name: options.name });
    }));

  // gssh workspace service attach --project <p> --workspace <w> --name <name>
  requireProjectAndWorkspace(
    service
      .command('attach')
      .description('Show attach hint for service')
  )
    .requiredOption('--name <name>', 'Service name')
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { attachProcess } = await import('../../commands/process.js');
      await attachProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace!), name: options.name });
    }));

  // gssh workspace service open --project <p> --workspace <w> --name <name>
  requireProjectAndWorkspace(
    service
      .command('open')
      .description('Open service HTTP ports in the browser')
  )
    .requiredOption('--name <name>', 'Service name')
    .option('--port <name-or-number>', 'Open a specific HTTP port by name or number')
    .option('--all', 'Open all HTTP ports for this service')
    .option('--local', 'Prefer local localhost URLs')
    .option('--remote', 'Require hosted URLs')
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { openProcess } = await import('../../commands/process.js');
      await openProcess({
        workspace: getWorkspacePath(ctx.project, ctx.workspace!),
        name: options.name,
        port: options.port,
        all: options.all,
        local: options.local,
        remote: options.remote,
      });
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
        throw new SpacesError('--workspace is required for bundle refresh', 'USER_ERROR', 1);
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
        throw new SpacesError('--workspace is required for bundle status', 'USER_ERROR', 1);
      }
      await bundleStatus({
        project: ctx.project,
        workspace: ctx.workspace,
      });
    }));

  // gssh workspace bundle show --project <p> --workspace <w>
  requireProjectAndWorkspace(
    bundle
      .command('show')
      .description('Show current bundle values, secret set-status, and confirm status')
  )
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { bundleShow } = await import('../../commands/bundle.js');
      if (!ctx.workspace) {
        throw new SpacesError('--workspace is required for bundle show', 'USER_ERROR', 1);
      }
      await bundleShow({
        project: ctx.project,
        workspace: ctx.workspace,
      });
    }));

  // gssh workspace bundle edit --project <p> --workspace <w>
  requireProjectAndWorkspace(
    bundle
      .command('edit')
      .description('Update bundle inputs, secrets, and confirm states')
  )
    .option('--input <key=value>', 'Set a non-secret input value (repeatable)', (value: string, previous: string[] = []) => {
      previous.push(value);
      return previous;
    })
    .option('--secret <key>', 'Prompt for a secret key value (repeatable)', (value: string, previous: string[] = []) => {
      previous.push(value);
      return previous;
    })
    .option('--secret-unset <key>', 'Unset a secret key value (repeatable)', (value: string, previous: string[] = []) => {
      previous.push(value);
      return previous;
    })
    .option('--confirm <id=status>', 'Set confirm status to passed|skipped (repeatable)', (value: string, previous: string[] = []) => {
      previous.push(value);
      return previous;
    })
    .action(withErrorHandler(async (options) => {
      const ctx = useExplicitContext(options);
      const { bundleEdit } = await import('../../commands/bundle.js');
      if (!ctx.workspace) {
        throw new SpacesError('--workspace is required for bundle edit', 'USER_ERROR', 1);
      }
      await bundleEdit({
        project: ctx.project,
        workspace: ctx.workspace,
        input: options.input,
        secret: options.secret,
        secretUnset: options.secretUnset,
        confirm: options.confirm,
      });
    }));
}
