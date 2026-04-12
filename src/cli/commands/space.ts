/**
 * gssh space [context|review|notes|service|hosting|events|bundle]
 *
 * Hidden workspace-scoped command surface. Typical usage inside a workspace is
 * `space review list`, not `gssh space review list`.
 * Context is resolved from GSSH_SPACE_PROJECT / GSSH_SPACE_WORKSPACE when present,
 * and otherwise falls back to detecting the current workspace from the cwd.
 *
 * @module cli/commands/space
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';
import { useSessionContext, getWorkspacePath } from '../workspace-context.js';
import { logger } from '../../utils/logger.js';

function shouldRenderWorkspaceScopedUsage(): boolean {
  const ctx = useSessionContext();
  return !!(ctx?.project && ctx.workspace);
}

function buildSpaceCommandUsage(cmd: Command): string {
  let cmdName = cmd.name();
  const aliases = (cmd as Command & { _aliases?: string[] })._aliases ?? [];
  if (aliases[0]) {
    cmdName = `${cmdName}|${aliases[0]}`;
  }

  let ancestors = '';
  for (let ancestor = cmd.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.name() === 'space') {
      ancestors = shouldRenderWorkspaceScopedUsage() ? `space ${ancestors}` : `gssh space ${ancestors}`;
      break;
    }
    ancestors = `${ancestor.name()} ${ancestors}`;
  }

  return `${ancestors}${cmdName} ${cmd.usage()}`.trim();
}

function configureSpaceHelpRecursively(command: Command): void {
  command.configureHelp({
    commandUsage: buildSpaceCommandUsage,
  });
  for (const subcommand of command.commands) {
    configureSpaceHelpRecursively(subcommand);
  }
}

function requireSessionContext(): { project: string; workspace: string } {
  const ctx = useSessionContext();
  if (!ctx || !ctx.project || !ctx.workspace) {
    logger.error('Workspace context is missing.');
    logger.log('Space commands require either a workspace-scoped shell or a cwd inside a GitSpace workspace.');
    process.exit(1);
  }

  return {
    project: ctx.project,
    workspace: ctx.workspace,
  };
}



export function registerSpaceCommands(parent: Command): void {
  const cmd = parent
    .command('space', { hidden: true })
    .description('Workspace-scoped commands such as `space review list`');

  cmd
    .command('context')
    .description('Show resolved workspace context')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { showSpaceContext } = await import('../../commands/review.js');
      await showSpaceContext(options);
    }));

  registerSpaceReviewCommands(cmd);
  registerSpaceNotesCommands(cmd);
  registerSpaceServiceCommands(cmd);
  registerSpaceHostingCommands(cmd);
  registerSpaceEventsCommands(cmd);
  registerSpaceBundleCommands(cmd);
  configureSpaceHelpRecursively(cmd);
}


function registerSpaceNotesCommands(space: Command): void {
  const notes = space
    .command('notes')
    .description('Manage local workspace notes and todos');

  notes
    .command('list')
    .description('List workspace notes')
    .option('--format <format>', 'Output format: json (default) or text')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { listNotes } = await import('../../commands/notes.js');
      await listNotes(options);
    }));

  notes
    .command('add')
    .description('Add a workspace note')
    .option('--body <text>', 'Note body')
    .option('--stdin', 'Read note body from stdin')
    .option('--todo', 'Add as todo')
    .option('--priority <priority>', 'Todo priority: low, medium, high')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { addNote } = await import('../../commands/notes.js');
      await addNote(options);
    }));

  notes
    .command('update')
    .description('Update a workspace note')
    .requiredOption('--id <id>', 'Note id')
    .option('--body <text>', 'New body')
    .option('--todo', 'Convert to todo')
    .option('--note', 'Convert to note')
    .option('--priority <priority>', 'Todo priority: low, medium, high')
    .option('--done', 'Mark todo done')
    .option('--undone', 'Mark todo open')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { updateNote } = await import('../../commands/notes.js');
      await updateNote(options);
    }));

  notes
    .command('remove')
    .description('Remove a workspace note')
    .requiredOption('--id <id>', 'Note id')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { removeNote } = await import('../../commands/notes.js');
      await removeNote(options);
    }));

  notes
    .command('done')
    .description('Mark a todo done')
    .requiredOption('--id <id>', 'Note id')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { markNoteDone } = await import('../../commands/notes.js');
      await markNoteDone(options);
    }));

  notes
    .command('undone')
    .description('Mark a todo open')
    .requiredOption('--id <id>', 'Note id')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { markNoteUndone } = await import('../../commands/notes.js');
      await markNoteUndone(options);
    }));
}

function registerSpaceReviewCommands(space: Command): void {
  const review = space
    .command('review')
    .description('Diff review system');

  review
    .command('list')
    .description('Print review threads as structured JSON')
    .option('--format <format>', 'Output format: json (default) or text')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { showReviewList } = await import('../../commands/review.js');
      await showReviewList(options);
    }));

  review
    .command('import')
    .description('Import GitHub PR review comments as local threads')
    .option('--pr <number>', 'PR number to import from', (v: string) => parseInt(v, 10))
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { importReview } = await import('../../commands/review.js');
      await importReview(options);
    }));

  review
    .command('push')
    .description('Push local review decisions to GitHub as a formal PR review')
    .option('--pr <number>', 'PR number to submit review on', (v: string) => parseInt(v, 10))
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { pushReview } = await import('../../commands/review.js');
      await pushReview(options);
    }));

  review
    .command('hunks')
    .description('List hunks in a changed file')
    .argument('<file>', 'File path')
    .option('--format <format>', 'Output format: json (default) or text')
    .action(withErrorHandler(async (file, options) => {
      requireSessionContext();
      const { listReviewHunks } = await import('../../commands/review.js');
      await listReviewHunks(file, options);
    }));

  review
    .command('add-hunk')
    .description('Add or update hunk review by hunk index')
    .argument('<file>', 'File path')
    .requiredOption('--index <number>', '1-based hunk index', (v: string) => parseInt(v, 10))
    .option('--body <text>', 'Optional comment body')
    .option('--approve', 'Set hunk decision to approved')
    .option('--reject', 'Set hunk decision to rejected')
    .option('--pending', 'Set hunk decision to pending')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (file, options) => {
      requireSessionContext();
      const { addHunkReview } = await import('../../commands/review.js');
      await addHunkReview(file, options);
    }));

  review
    .command('add-file')
    .description('Add a file-level review thread')
    .argument('<file>', 'File path')
    .requiredOption('--body <text>', 'Comment body')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (file, options) => {
      requireSessionContext();
      const { addFileReview } = await import('../../commands/review.js');
      await addFileReview(file, options);
    }));

  review
    .command('add-line')
    .description('Add a line-range review thread')
    .argument('<file>', 'File path')
    .requiredOption('--start <number>', '1-based start line', (v: string) => parseInt(v, 10))
    .option('--end <number>', '1-based end line (defaults to start)', (v: string) => parseInt(v, 10))
    .option('--side <side>', 'LEFT or RIGHT side of diff (default: RIGHT)')
    .requiredOption('--body <text>', 'Comment body')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (file, options) => {
      requireSessionContext();
      const { addLineReview } = await import('../../commands/review.js');
      await addLineReview(file, options);
    }));
}

function registerSpaceServiceCommands(space: Command): void {
  const service = space
    .command('service')
    .description('Manage workspace services');

  service
    .command('list')
    .description('List configured services')
    .action(withErrorHandler(async () => {
      const ctx = requireSessionContext();
      const { listProcesses } = await import('../../commands/process.js');
      await listProcesses({ workspace: getWorkspacePath(ctx.project, ctx.workspace) });
    }));

  service
    .command('start')
    .description('Start a service by name')
    .requiredOption('--name <name>', 'Service name')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { startProcess } = await import('../../commands/process.js');
      await startProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace), name: options.name });
    }));

  service
    .command('stop')
    .description('Stop a service by name')
    .requiredOption('--name <name>', 'Service name')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { stopProcess } = await import('../../commands/process.js');
      await stopProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace), name: options.name });
    }));

  service
    .command('attach')
    .description('Show attach hint for service')
    .requiredOption('--name <name>', 'Service name')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { attachProcess } = await import('../../commands/process.js');
      await attachProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace), name: options.name });
    }));

  service
    .command('open')
    .description('Open service HTTP ports in the browser')
    .requiredOption('--name <name>', 'Service name')
    .option('--port <name-or-number>', 'Open a specific HTTP port by name or number')
    .option('--all', 'Open all HTTP ports for this service')
    .option('--local', 'Prefer local localhost URLs')
    .option('--remote', 'Require hosted URLs')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { openProcess } = await import('../../commands/process.js');
      await openProcess({
        workspace: getWorkspacePath(ctx.project, ctx.workspace),
        name: options.name,
        port: options.port,
        all: options.all,
        local: options.local,
        remote: options.remote,
      });
    }));
}

function registerSpaceHostingCommands(space: Command): void {
  const hosting = space
    .command('hosting')
    .description('Configure tmux-lite service hosting');

  hosting
    .command('status')
    .description('Show tmux-lite hosting status')
    .action(withErrorHandler(async () => {
      const { statusTmuxHosting } = await import('../../commands/tmux.js');
      await statusTmuxHosting();
    }));

  hosting
    .command('select')
    .description('Select the base host used for tmux-lite service hosting')
    .argument('[host]', 'Hosting base host, reserved name, or reserved .serve name')
    .action(withErrorHandler(async (host) => {
      const { selectTmuxHosting } = await import('../../commands/tmux.js');
      await selectTmuxHosting(host);
    }));

  hosting
    .command('set-name')
    .description('Set the machine name used in hosted service routes')
    .argument('<name>', 'Machine name')
    .action(withErrorHandler(async (name) => {
      const { setTmuxHostingMachineName } = await import('../../commands/tmux.js');
      await setTmuxHostingMachineName(name);
    }));

  hosting
    .command('enable')
    .description('Enable tmux-lite service hosting')
    .action(withErrorHandler(async () => {
      const { enableTmuxHosting } = await import('../../commands/tmux.js');
      await enableTmuxHosting();
    }));

  hosting
    .command('disable')
    .description('Disable tmux-lite service hosting')
    .action(withErrorHandler(async () => {
      const { disableTmuxHosting } = await import('../../commands/tmux.js');
      await disableTmuxHosting();
    }));

  hosting
    .command('clear')
    .description('Clear tmux-lite hosting configuration')
    .action(withErrorHandler(async () => {
      const { clearTmuxHosting } = await import('../../commands/tmux.js');
      await clearTmuxHosting();
    }));
}

function registerSpaceEventsCommands(space: Command): void {
  const events = space
    .command('events')
    .description('Query workspace event logs');

  events
    .command('list')
    .description('List events (NDJSON)')
    .option('--filter <expr>', 'Filter in key=value format')
    .option('--limit <n>', 'Limit results', (v: string) => Number(v), 100)
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { listEvents } = await import('../../commands/events.js');
      await listEvents(options);
    }));

  events
    .command('show')
    .description('Show a single event by eventId')
    .option('--filter <expr>', 'Filter in key=value format')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { showEvent } = await import('../../commands/events.js');
      await showEvent(options);
    }));

  events
    .command('tail')
    .description('Tail recent events (no follow yet)')
    .option('--filter <expr>', 'Filter in key=value format')
    .option('--limit <n>', 'Limit results', (v: string) => Number(v), 50)
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { tailEvents } = await import('../../commands/events.js');
      await tailEvents(options);
    }));
}

function registerSpaceBundleCommands(space: Command): void {
  const bundle = space
    .command('bundle')
    .description('Manage workspace bundle configuration');

  bundle
    .command('refresh')
    .description('Re-run bundle onboarding for this workspace')
    .option('--force', 'Force refresh even if no changes detected')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { bundleRefresh } = await import('../../commands/bundle.js');
      await bundleRefresh({
        project: ctx.project,
        workspace: ctx.workspace,
        force: options.force,
      });
    }));

  bundle
    .command('status')
    .description('Show bundle status for this workspace')
    .action(withErrorHandler(async () => {
      const ctx = requireSessionContext();
      const { bundleStatus } = await import('../../commands/bundle.js');
      await bundleStatus({
        project: ctx.project,
        workspace: ctx.workspace,
      });
    }));

  bundle
    .command('show')
    .description('Show current bundle values, secret set-status, and confirm status')
    .action(withErrorHandler(async () => {
      const ctx = requireSessionContext();
      const { bundleShow } = await import('../../commands/bundle.js');
      await bundleShow({
        project: ctx.project,
        workspace: ctx.workspace,
      });
    }));

  bundle
    .command('edit')
    .description('Update bundle inputs, secrets, and confirm states')
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
      const ctx = requireSessionContext();
      const { bundleEdit } = await import('../../commands/bundle.js');
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
