import type { AutocompleteItem } from '@oh-my-pi/pi-tui';

interface SpaceAutocompleteNode {
  subcommands?: Record<string, SpaceAutocompleteNode>;
  options?: string[];
}

const SPACE_OPTION_VALUE_FLAGS = new Set([
  '--format',
  '--pr',
  '--index',
  '--body',
  '--start',
  '--end',
  '--side',
  '--id',
  '--priority',
  '--name',
  '--port',
  '--filter',
  '--limit',
  '--process',
  '--level',
  '--event',
  '--event-id',
  '--correlation-id',
  '--since',
  '--until',
  '--order',
  '--input',
  '--secret',
  '--secret-unset',
  '--confirm',
]);

const SPACE_COMMAND_TREE: SpaceAutocompleteNode = {
  subcommands: {
    context: {},
    review: {
      subcommands: {
        list: { options: ['--format'] },
        import: { options: ['--pr'] },
        push: { options: ['--pr'] },
        hunks: { options: ['--format'] },
        'add-hunk': { options: ['--index', '--body', '--approve', '--reject', '--pending', '--json'] },
        'add-file': { options: ['--body', '--json'] },
        'add-line': { options: ['--start', '--end', '--side', '--body', '--json'] },
      },
    },
    notes: {
      subcommands: {
        list: { options: ['--format'] },
        add: { options: ['--body', '--stdin', '--todo', '--priority', '--json'] },
        update: { options: ['--id', '--body', '--todo', '--note', '--priority', '--done', '--undone', '--json'] },
        remove: { options: ['--id', '--json'] },
        done: { options: ['--id', '--json'] },
        undone: { options: ['--id', '--json'] },
      },
    },
    service: {
      subcommands: {
        list: {},
        start: { options: ['--name'] },
        stop: { options: ['--name'] },
        attach: { options: ['--name'] },
        open: { options: ['--name', '--port', '--all', '--local', '--remote'] },
      },
    },
    hosting: {
      subcommands: {
        status: {},
        select: {},
        'set-name': {},
        enable: {},
        disable: {},
        clear: {},
      },
    },
    events: {
      subcommands: {
        list: {
          options: ['--filter', '--limit', '--process', '--level', '--event', '--event-id', '--correlation-id', '--since', '--until', '--head', '--tail', '--order'],
        },
        show: { options: ['--filter', '--event-id'] },
        tail: {
          options: ['--filter', '--limit', '--process', '--level', '--event', '--event-id', '--correlation-id', '--since', '--until', '--follow'],
        },
      },
    },
    bundle: {
      subcommands: {
        refresh: { options: ['--force'] },
        status: {},
        show: {},
        edit: { options: ['--input', '--secret', '--secret-unset', '--confirm'] },
      },
    },
  },
};

const SPACE_SUBCOMMAND_DESCRIPTIONS: Record<string, string> = {
  'context': 'Show resolved workspace context',
  'review': 'Diff review system',
  'review list': 'Print review threads as structured JSON',
  'review import': 'Import GitHub PR review comments as local threads',
  'review push': 'Push local review decisions to GitHub as a formal PR review',
  'review hunks': 'List hunks in a changed file',
  'review add-hunk': 'Add or update hunk review by hunk index',
  'review add-file': 'Add a file-level review thread',
  'review add-line': 'Add a line-range review thread',
  'notes': 'Manage local workspace notes and todos',
  'notes list': 'List workspace notes',
  'notes add': 'Add a workspace note',
  'notes update': 'Update a workspace note',
  'notes remove': 'Remove a workspace note',
  'notes done': 'Mark a todo done',
  'notes undone': 'Mark a todo open',
  'service': 'Manage workspace services',
  'service list': 'List configured services',
  'service start': 'Start a service by name',
  'service stop': 'Stop a service by name',
  'service attach': 'Show attach hint for service',
  'service open': 'Open service HTTP ports in the browser',
  'hosting': 'Configure tmux-lite service hosting',
  'hosting status': 'Show tmux-lite hosting status',
  'hosting select': 'Select the base host used for tmux-lite service hosting',
  'hosting set-name': 'Set the machine name used in hosted service routes',
  'hosting enable': 'Enable tmux-lite service hosting',
  'hosting disable': 'Disable tmux-lite service hosting',
  'hosting clear': 'Clear tmux-lite hosting configuration',
  'events': 'Query workspace event logs',
  'events list': 'List events',
  'events show': 'Show a single event by eventId',
  'events tail': 'Tail recent events',
  'bundle': 'Manage workspace bundle configuration',
  'bundle refresh': 'Re-run bundle onboarding for this workspace',
  'bundle status': 'Show bundle status for this workspace',
  'bundle show': 'Show current bundle values, secret set-status, and confirm status',
  'bundle edit': 'Update bundle inputs, secrets, and confirm states',
};

const SPACE_OPTION_DESCRIPTIONS: Record<string, string> = {
  '--format': 'Output format such as json or text',
  '--pr': 'Pull request number',
  '--index': '1-based hunk index',
  '--body': 'Comment or note body text',
  '--approve': 'Mark review decision approved',
  '--reject': 'Mark review decision rejected',
  '--pending': 'Mark review decision pending',
  '--json': 'Output structured JSON',
  '--start': '1-based start line',
  '--end': '1-based end line',
  '--side': 'Diff side, usually LEFT or RIGHT',
  '--id': 'Workspace note identifier',
  '--stdin': 'Read body from stdin',
  '--todo': 'Treat note as todo',
  '--note': 'Treat item as note',
  '--priority': 'Todo priority such as low, medium, or high',
  '--done': 'Mark todo done',
  '--undone': 'Mark todo open',
  '--name': 'Service or machine name',
  '--port': 'Specific service port name or number',
  '--all': 'Apply to all matching ports',
  '--local': 'Prefer local localhost URLs',
  '--remote': 'Require hosted URLs',
  '--filter': 'Repeatable key=value event filter',
  '--limit': 'Maximum number of results',
  '--process': 'Filter by process name',
  '--level': 'Filter by event level',
  '--event': 'Filter by event name',
  '--event-id': 'Filter by event id',
  '--correlation-id': 'Filter by correlation id',
  '--since': 'Lower time bound as duration or ISO timestamp',
  '--until': 'Upper time bound as duration or ISO timestamp',
  '--head': 'Show oldest matching events',
  '--tail': 'Show newest matching events',
  '--order': 'Sort order asc or desc',
  '--follow': 'Continue streaming new events',
  '--force': 'Force refresh even if no changes detected',
  '--input': 'Set a non-secret bundle input key=value',
  '--secret': 'Prompt for a bundle secret key',
  '--secret-unset': 'Unset a bundle secret key',
  '--confirm': 'Set confirm status as id=status',
};


function extractCommandTokens(parts: string[]): string[] {
  const commandTokens: string[] = [];
  let skipNextValue = false;
  for (const part of parts) {
    if (skipNextValue) {
      skipNextValue = false;
      continue;
    }
    if (part.startsWith('--')) {
      if (SPACE_OPTION_VALUE_FLAGS.has(part)) {
        skipNextValue = true;
      }
      continue;
    }
    commandTokens.push(part);
  }
  return commandTokens;
}

function resolveAutocompleteNode(commandTokens: string[]): SpaceAutocompleteNode {
  let node = SPACE_COMMAND_TREE;
  for (const token of commandTokens) {
    const next = node.subcommands?.[token];
    if (!next) break;
    node = next;
  }
  return node;
}

function describeCandidate(commandTokens: string[], candidate: string): string | undefined {
  if (candidate.startsWith('--')) {
    return SPACE_OPTION_DESCRIPTIONS[candidate];
  }
  const path = [...commandTokens, candidate].join(' ');
  return SPACE_SUBCOMMAND_DESCRIPTIONS[path] ?? SPACE_SUBCOMMAND_DESCRIPTIONS[candidate];
}


function buildAutocompleteItems(commandTokens: string[], candidates: string[], activePrefix: string): AutocompleteItem[] | null {
  const filtered = candidates
    .filter((candidate) => candidate.startsWith(activePrefix))
    .map((candidate) => ({
      label: candidate,
      value: `${candidate} `,
      description: describeCandidate(commandTokens, candidate),
    } satisfies AutocompleteItem));
  return filtered.length > 0 ? filtered : null;
}

export function getSpaceCommandArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const hasTrailingWhitespace = /\s$/.test(argumentPrefix);
  const rawParts = argumentPrefix.trim().length > 0
    ? argumentPrefix.trim().split(/\s+/)
    : [];
  const completedParts = hasTrailingWhitespace ? rawParts : rawParts.slice(0, -1);
  const activePrefix = hasTrailingWhitespace ? '' : (rawParts.at(-1) ?? '');
  const commandTokens = extractCommandTokens(completedParts);
  const node = resolveAutocompleteNode(commandTokens);

  if (activePrefix.startsWith('--')) {
    return buildAutocompleteItems(commandTokens, node.options ?? [], activePrefix);
  }

  const subcommands = Object.keys(node.subcommands ?? {});
  if (subcommands.length > 0) {
    return buildAutocompleteItems(commandTokens, subcommands, activePrefix);
  }

  return buildAutocompleteItems(commandTokens, node.options ?? [], activePrefix);
}
