/**
 * gssh space [context|review|process|events|bundle]
 *
 * Hidden command surface intended for use inside tmux-lite workspace sessions.
 * Context is resolved from GSSH_SPACE_PROJECT / GSSH_SPACE_WORKSPACE env vars
 * set by tmux-lite when spawning workspace sessions.
 *
 * @module cli/commands/space
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';
import { useSessionContext, getWorkspacePath } from '../workspace-context.js';
import { logger } from '../../utils/logger.js';

function requireSessionContext(): { project: string; workspace: string } {
  if (process.env.GSSH_SESSION_MODE !== 'workspace') {
    logger.error('Not inside a workspace session.');
    logger.log('Space commands are only available in workspace session mode.');
    process.exit(1);
  }

  const ctx = useSessionContext();
  if (!ctx || !ctx.project || !ctx.workspace) {
    logger.error('Workspace session context is missing.');
    logger.log('Space commands require GSSH_SPACE_PROJECT and GSSH_SPACE_WORKSPACE env vars.');
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
    .description('Workspace-scoped commands (session-only)');

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
  registerSpaceProcessCommands(cmd);
  registerSpaceEventsCommands(cmd);
  registerSpaceBundleCommands(cmd);
}

function registerSpaceReviewCommands(space: Command): void {
  const review = space
    .command('review')
    .description('Diff review system');

  review
    .command('notes')
    .description('Print review threads as structured JSON')
    .option('--format <format>', 'Output format: json (default) or text')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { showReviewNotes } = await import('../../commands/review.js');
      await showReviewNotes(options);
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

function registerSpaceProcessCommands(space: Command): void {
  const proc = space
    .command('process')
    .description('Manage workspace processes');

  proc
    .command('list')
    .description('List configured processes')
    .action(withErrorHandler(async () => {
      const ctx = requireSessionContext();
      const { listProcesses } = await import('../../commands/process.js');
      await listProcesses({ workspace: getWorkspacePath(ctx.project, ctx.workspace) });
    }));

  proc
    .command('start')
    .description('Start a process by name')
    .requiredOption('--name <name>', 'Process name')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { startProcess } = await import('../../commands/process.js');
      await startProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace), name: options.name });
    }));

  proc
    .command('stop')
    .description('Stop a process by name')
    .requiredOption('--name <name>', 'Process name')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { stopProcess } = await import('../../commands/process.js');
      await stopProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace), name: options.name });
    }));

  proc
    .command('attach')
    .description('Show attach hint for process')
    .requiredOption('--name <name>', 'Process name')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { attachProcess } = await import('../../commands/process.js');
      await attachProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace), name: options.name });
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
