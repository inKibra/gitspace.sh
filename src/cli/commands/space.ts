/**
 * gssh space [context|goal|chain|stack|review|notes|service|hosting|events|bundle]
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


function collectRepeated(value: string, previous: string[]): string[] {
  return [...previous, value];
}
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

function collectFilter(value: string, previous: string[] = []): string[] {
  return [...previous, value];
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
  registerSpaceGoalCommands(cmd);
  registerSpaceChainCommands(cmd);
  registerSpaceStackCommands(cmd);
  registerSpaceNotesCommands(cmd);
  registerSpaceServiceCommands(cmd);
  registerSpaceHostingCommands(cmd);
  registerSpaceEventsCommands(cmd);
  registerSpaceBundleCommands(cmd);
  configureSpaceHelpRecursively(cmd);
}



function registerSpaceGoalCommands(space: Command): void {
  const goal = space
    .command('goal')
    .description('Author goal doc, declare validation contract, and judge requirements');

  goal
    .command('show')
    .description('Show the current goal document')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { showSpaceGoal } = await import('../../commands/space-goals.js');
      showSpaceGoal(ctx, options);
    }));

  goal
    .command('set')
    .description('Replace the current goal document')
    .option('--file <path>', 'Read goal markdown from file')
    .option('--stdin', 'Read goal markdown from stdin')
    .option('--body <text>', 'Goal markdown body')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { setSpaceGoal } = await import('../../commands/space-goals.js');
      setSpaceGoal(ctx, options);
    }));

  goal
    .command('edit')
    .description('Edit the current goal document with EDITOR')
    .option('--editor <command>', 'Editor command')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { editSpaceGoal } = await import('../../commands/space-goals.js');
      editSpaceGoal(ctx, options);
    }));

  goal
    .command('status')
    .description('Show validation readiness for this goal')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { showSpaceGoalStatus } = await import('../../commands/space-goals.js');
      showSpaceGoalStatus(ctx, options);
    }));

  const requirement = goal
    .command('requirement')
    .description('Declare artifact requirements; each requirement owns its rubric, generation, and judgment');

  requirement
    .command('add')
    .description('Declare an artifact requirement on the validation contract')
    .requiredOption('--title <title>', 'Requirement title (e.g. "Screenshot showing the hover state")')
    .requiredOption('--kind <kind>', 'Artifact kind: screenshot, video, test-output, note, file, url')
    .requiredOption('--rubric <text>', 'Acceptance criteria: what makes this evidence acceptable')
    .requiredOption('--gen <kind>', 'Generation: manual | command')
    .option('--gen-command <command>', 'Command to run when --gen=command')
    .requiredOption('--judge <kind>', 'Judgment: human | llm | command')
    .option('--judge-command <command>', 'Judgment command when --judge=command')
    .option('--expect <kind>', 'Command expectation: exit-zero | stdout-contains | stderr-empty | output-matches', 'exit-zero')
    .option('--expect-needle <text>', 'Required substring when --expect=stdout-contains')
    .option('--expect-pattern <regex>', 'Required regex when --expect=output-matches')
    .option('--model-hint <name>', 'Preferred LLM model when --judge=llm')
    .option('--optional', 'Mark the requirement optional (default: required)')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { addSpaceGoalRequirement } = await import('../../commands/space-goals.js');
      addSpaceGoalRequirement(ctx, options);
    }));

  requirement
    .command('update')
    .description('Update an existing requirement on the validation contract')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .option('--title <title>', 'New requirement title')
    .option('--kind <kind>', 'Artifact kind: screenshot, video, test-output, note, file, url')
    .option('--rubric <text>', 'Acceptance criteria')
    .option('--gen <kind>', 'Generation: manual | command')
    .option('--gen-command <command>', 'Command to run when --gen=command')
    .option('--judge <kind>', 'Judgment: human | llm | command')
    .option('--judge-command <command>', 'Judgment command when --judge=command')
    .option('--expect <kind>', 'Command expectation: exit-zero | stdout-contains | stderr-empty | output-matches')
    .option('--expect-needle <text>', 'Required substring when --expect=stdout-contains')
    .option('--expect-pattern <regex>', 'Required regex when --expect=output-matches')
    .option('--model-hint <name>', 'Preferred LLM model when --judge=llm')
    .option('--required', 'Mark the requirement required')
    .option('--optional', 'Mark the requirement optional')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { updateSpaceGoalRequirement } = await import('../../commands/space-goals.js');
      updateSpaceGoalRequirement(ctx, options);
    }));

  requirement
    .command('remove')
    .description('Remove an artifact requirement from this goal')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { removeSpaceGoalRequirement } = await import('../../commands/space-goals.js');
      removeSpaceGoalRequirement(ctx, options);
    }));

  requirement
    .command('list')
    .description('List artifact requirements on this goal')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { listSpaceGoalRequirements } = await import('../../commands/space-goals.js');
      listSpaceGoalRequirements(ctx, options);
    }));

  requirement
    .command('reorder')
    .description('Move an artifact requirement to a specific position (0-indexed)')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .requiredOption('--position <index>', '0-indexed target position', (v) => parseInt(v, 10))
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { reorderSpaceGoalRequirement } = await import('../../commands/space-goals.js');
      reorderSpaceGoalRequirement(ctx, options);
    }));

  requirement
    .command('reopen')
    .description('Reopen a requirement for re-review (sets status back to review)')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { reopenSpaceGoalRequirement } = await import('../../commands/space-goals.js');
      reopenSpaceGoalRequirement(ctx, options);
    }));

  const artifact = goal
    .command('artifact')
    .description('Attach or generate artifacts that fulfill a requirement');

  artifact
    .command('attach')
    .description('Attach an artifact manually against a declared requirement')
    .requiredOption('--requirement <requirement>', 'Requirement id or title to fulfill')
    .option('--name <label>', 'Display label for the attached artifact')
    .option('--body <text>', 'Inline body (for note evidence)')
    .option('--file <path>', 'Read body from file')
    .option('--stdin', 'Read body from stdin')
    .option('--path <path>', 'Local path to a file/screenshot/video')
    .option('--url <url>', 'URL reference (for url requirements)')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { attachSpaceGoalEvidence } = await import('../../commands/space-goals.js');
      attachSpaceGoalEvidence(ctx, options);
    }));

  artifact
    .command('run')
    .description('Run the requirement\u2019s configured generation command to produce evidence')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { runSpaceGoalGeneration } = await import('../../commands/space-goals.js');
      runSpaceGoalGeneration(ctx, options);
    }));

  const review = goal
    .command('review')
    .description('Judge a requirement against its rubric (record human review or run command/LLM judgment)');

  review
    .command('run')
    .description('Run the requirement\u2019s configured judgment (command or LLM)')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { runSpaceGoalJudgment } = await import('../../commands/space-goals.js');
      runSpaceGoalJudgment(ctx, options);
    }));

  review
    .command('record')
    .description('Record a human review decision for a requirement')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .requiredOption('--decision <decision>', 'pass | changes | fail')
    .option('--body <text>', 'Review note')
    .option('--file <path>', 'Read note from file')
    .option('--stdin', 'Read note from stdin')
    .option('--created-by <name>', 'Reviewer identity label')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { recordSpaceGoalHumanReview } = await import('../../commands/space-goals.js');
      recordSpaceGoalHumanReview(ctx, options);
    }));
}

function registerSpaceChainCommands(space: Command): void {
  const chain = space
    .command('chain')
    .description('Manage this space linear goal chain');

  chain
    .command('show')
    .description('Show this goal chain')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { showSpaceChain } = await import('../../commands/space-goals.js');
      showSpaceChain(ctx, options);
    }));

  chain
    .command('add-after')
    .description('Add a planned goal after the current workspace goal')
    .requiredOption('--title <title>', 'Goal title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { addSpaceChainGoal } = await import('../../commands/space-goals.js');
      addSpaceChainGoal(ctx, options.title, 'after', options);
    }));

  chain
    .command('add-before')
    .description('Add a planned goal before the current workspace goal')
    .requiredOption('--title <title>', 'Goal title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { addSpaceChainGoal } = await import('../../commands/space-goals.js');
      addSpaceChainGoal(ctx, options.title, 'before', options);
    }));

  chain
    .command('move-before')
    .description('Move the current goal before another goal in the current project')
    .argument('<target>', 'Goal id, workspace name, planned workspace name, or title to move before')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title to move (defaults to current workspace goal)')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (targetToken, options) => {
      const ctx = requireSessionContext();
      const { moveSpaceChainGoal } = await import('../../commands/space-goals.js');
      moveSpaceChainGoal(ctx, options.goal ?? ctx.workspace, targetToken, 'before', options);
    }));

  chain
    .command('move-after')
    .description('Move the current goal after another goal in the current project')
    .argument('<target>', 'Goal id, workspace name, planned workspace name, or title to move after')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title to move (defaults to current workspace goal)')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (targetToken, options) => {
      const ctx = requireSessionContext();
      const { moveSpaceChainGoal } = await import('../../commands/space-goals.js');
      moveSpaceChainGoal(ctx, options.goal ?? ctx.workspace, targetToken, 'after', options);
    }));

  chain
    .command('create-workspace')
    .description('Create a workspace for a planned goal')
    .option('--goal <goal>', 'Goal id, planned workspace name, or title (defaults to current goal)')
    .option('--name <workspace>', 'Workspace name')
    .option('--branch <branch>', 'Branch name')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { createSpaceChainWorkspace } = await import('../../commands/space-goals.js');
      await createSpaceChainWorkspace(ctx, options);
    }));
}

function registerSpaceStackCommands(space: Command): void {
  const stack = space
    .command('stack')
    .description('Validate this space git stack');

  stack
    .command('status')
    .description('Show adjacent goal workspace ancestry status')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { showSpaceStackStatus } = await import('../../commands/space-goals.js');
      showSpaceStackStatus(ctx, options);
    }));
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
    .option('--filter <expr>', 'Filter in key=value format (repeatable)', collectFilter, [])
    .option('--limit <n>', 'Limit results', (v: string) => Number(v), 100)
    .option('--process <name>', 'Filter by process name')
    .option('--level <level>', 'Filter by event level')
    .option('--event <name>', 'Filter by event name')
    .option('--event-id <id>', 'Filter by event id')
    .option('--correlation-id <id>', 'Filter by correlation id')
    .option('--since <time>', 'Filter since duration (30m, 2h) or ISO timestamp')
    .option('--until <time>', 'Filter until duration (30m, 2h) or ISO timestamp')
    .option('--head [n]', 'Show oldest matching events', (v: string | undefined) => v === undefined ? 100 : Number(v))
    .option('--tail [n]', 'Show newest matching events', (v: string | undefined) => v === undefined ? 100 : Number(v))
    .option('--order <order>', 'Sort order: asc or desc')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { listEvents } = await import('../../commands/events.js');
      await listEvents({ ...options, ...ctx });
    }));

  events
    .command('show')
    .description('Show a single event by eventId')
    .option('--filter <expr>', 'Filter in key=value format (repeatable)', collectFilter, [])
    .option('--event-id <id>', 'Event id')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { showEvent } = await import('../../commands/events.js');
      await showEvent({ ...options, ...ctx });
    }));

  events
    .command('tail')
    .description('Tail recent events')
    .option('--filter <expr>', 'Filter in key=value format (repeatable)', collectFilter, [])
    .option('--limit <n>', 'Limit results', (v: string) => Number(v), 50)
    .option('--process <name>', 'Filter by process name')
    .option('--level <level>', 'Filter by event level')
    .option('--event <name>', 'Filter by event name')
    .option('--event-id <id>', 'Filter by event id')
    .option('--correlation-id <id>', 'Filter by correlation id')
    .option('--since <time>', 'Filter since duration (30m, 2h) or ISO timestamp')
    .option('--until <time>', 'Filter until duration (30m, 2h) or ISO timestamp')
    .option('--follow', 'Continue streaming new events')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { tailEvents } = await import('../../commands/events.js');
      await tailEvents({ ...options, ...ctx });
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
