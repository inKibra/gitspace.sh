import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent';
import { parseCommandArgs } from '@oh-my-pi/pi-coding-agent/utils/command-args';
import type { HookCommandContext } from '@oh-my-pi/pi-coding-agent/extensibility/hooks/types';
import type { AutocompleteItem } from '@oh-my-pi/pi-tui';
import { getWorkspaceRoot } from '../../../../core/paths.js';
import { buildWorkspaceScopedExecCommand } from '../../../../session/workspace-shell-hooks.js';
import { detectWorkspaceContextFromCwd } from '../../../../utils/workspace-id.js';

const SPACE_TOP_LEVEL_SUBCOMMANDS = ['context', 'review', 'notes', 'service', 'hosting', 'events', 'bundle'];
const SPACE_REVIEW_SUBCOMMANDS = ['list', 'import', 'push', 'hunks', 'add-hunk', 'add-file', 'add-line'];
const SPACE_NOTES_SUBCOMMANDS = ['list', 'add', 'update', 'remove', 'done', 'undone'];

export function getSpaceCommandArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const hasTrailingWhitespace = /\s$/.test(argumentPrefix);
  const rawParts = argumentPrefix.trim().length > 0
    ? argumentPrefix.trim().split(/\s+/)
    : [];
  const completedParts = hasTrailingWhitespace ? rawParts : rawParts.slice(0, -1);
  const activePrefix = hasTrailingWhitespace ? '' : (rawParts.at(-1) ?? '');
  const commandContext = completedParts[0] ?? rawParts[0] ?? '';
  const candidates = commandContext === 'review'
    ? SPACE_REVIEW_SUBCOMMANDS
    : commandContext === 'notes'
      ? SPACE_NOTES_SUBCOMMANDS
      : SPACE_TOP_LEVEL_SUBCOMMANDS;
  const filtered = candidates
    .filter((candidate) => candidate.startsWith(activePrefix))
    .map((candidate) => ({ label: candidate, value: `${candidate} ` } satisfies AutocompleteItem));
  return filtered.length > 0 ? filtered : null;
}

function formatSpaceCommandResult(args: string[], result: { stdout: string; stderr: string; code: number }): string {
  const commandLabel = args.length > 0 ? `space ${args.join(' ')}` : 'space';
  const sections = [`Output from \`${commandLabel}\` in the current workspace:`];
  const stdout = result.stdout.trimEnd();
  const stderr = result.stderr.trimEnd();

  if (stdout.length > 0) {
    sections.push(stdout);
  }

  if (stderr.length > 0) {
    sections.push(`stderr:\n${stderr}`);
  }

  if (result.code !== 0) {
    sections.push(`exit code: ${result.code}`);
  }

  if (stdout.length === 0 && stderr.length === 0) {
    sections.push(result.code === 0 ? '(no output)' : '(command failed with no output)');
  }

  return sections.join('\n\n');
}

export async function executeSpaceCommand(
  api: Pick<ExtensionAPI, 'exec'>,
  ctx: Pick<HookCommandContext, 'cwd'>,
  args: string[],
  launcherArgs?: string[],
): Promise<string> {
  if (args.includes('--project') || args.includes('--workspace')) {
    throw new Error('/space always targets the current workspace. Omit --project and --workspace.');
  }

  const workspace = detectWorkspaceContextFromCwd(ctx.cwd, getWorkspaceRoot());
  if (!workspace) {
    throw new Error(`Could not resolve a GitSpace workspace from ${ctx.cwd}`);
  }

  const commandSpec = buildWorkspaceScopedExecCommand(
    workspace.projectName,
    workspace.workspaceName,
    args,
    launcherArgs,
  );
  const result = await api.exec(commandSpec.command, commandSpec.args, { cwd: ctx.cwd });
  return formatSpaceCommandResult(args, result);
}

export default function gitSpaceSpaceCommandExtension(pi: ExtensionAPI) {
  pi.registerCommand('space', {
    description: 'Run workspace-scoped GitSpace commands like `space review list` in the current workspace',
    getArgumentCompletions: getSpaceCommandArgumentCompletions,
    handler: async (argsText, ctx) => {
      const output = await executeSpaceCommand(pi, ctx, parseCommandArgs(argsText));
      pi.sendUserMessage(output);
    },
  });
}
