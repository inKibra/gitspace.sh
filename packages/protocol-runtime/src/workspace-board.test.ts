import { expect, test } from 'bun:test';
import { emptyWorkspaceStatus, type WorkspaceStatusSummary } from '@gitspace/protocol-workspace';
import { workspaceBoard, workspaceBoardChanges, type WorkspaceBoardRow } from './workspace-board.js';

const colored = (primaryColor: WorkspaceStatusSummary['primaryColor'], conflicts = 0): WorkspaceStatusSummary => ({ ...emptyWorkspaceStatus, primaryColor, sync: { conflicts, problems: 0 } });
const at = new Date('2026-11-08T18:46:05Z');
const row = (workspaceId: string, name: string, changes: Partial<WorkspaceBoardRow>): WorkspaceBoardRow => ({
  workspaceId, name, phase: 'code', lifecycle: 'active', status: colored('blue'), waitingOn: null, pullRequest: null, since: '2026-11-08T17:02:00Z', ...changes,
});
const rows = [
  row('billing', 'Billing export', { status: colored('orange'), waitingOn: { kind: 'ask', prompt: 'Which bucket should\nexports go to?' }, pullRequest: 42, since: '2026-11-08T18:31:00Z' }),
  row('search', 'Search index', { phase: 'plan', status: colored('green'), since: '2026-11-07T23:10:00Z' }),
  row('docs', 'Docs refresh', { phase: 'review' }),
  row('sync', 'Sync repair', { status: colored('orange', 2), since: null }),
  row('import', 'Importer', { lifecycle: 'provisioning', status: null, since: null }),
  row('old', 'Old spike', { lifecycle: 'archived' }),
];

test('a board line shows each workspace\'s phase, what it is doing and on what it waits, its pull request and since when', () => {
  expect(workspaceBoard(rows, at)).toBe([
    'Workspace board, 2026-11-08 18:46:05 UTC (5 workspaces):',
    '- Billing export (billing) · code · waiting on a person to answer "Which bucket should exports go to?" · PR #42 · since 18:31',
    '- Search index (search) · plan · working · since 11-07 23:10',
    '- Docs refresh (docs) · review · idle · since 17:02',
    '- Sync repair (sync) · code · waiting on a person to resolve sync conflicts',
    '- Importer (import) · code · provisioning · no status yet',
  ].join('\n'));
  const approval = workspaceBoard([row('plan', 'Planner', { status: colored('orange'), waitingOn: { kind: 'approval', prompt: 'x'.repeat(300) } }), row('broken', 'Broken', { status: colored('red') })], at);
  expect(approval).toContain(`Planner (plan) · code · waiting on a person to approve "${'x'.repeat(120)}…"`);
  expect(approval).toContain('Broken (broken) · code · failed');
  expect(workspaceBoard([rows[5]!], at)).toBe('Workspace board, 2026-11-08 18:46:05 UTC: no workspaces.');
});

test('the changes between two reads name only the workspaces whose line changed, new ones and those that left', () => {
  const later = new Date('2026-11-08T19:05:00Z');
  const current = [
    row('billing', 'Billing export', { status: colored('green'), pullRequest: 42, since: '2026-11-08T18:50:00Z' }),
    rows[1]!,
    row('docs', 'Docs refresh', { phase: 'review', lifecycle: 'archived' }),
    rows[3]!,
    rows[4]!,
    row('onboarding', 'Onboarding', { phase: 'plan', since: '2026-11-08T19:01:00Z' }),
  ];
  expect(workspaceBoardChanges(rows, current, at, later)).toBe([
    'Workspace board changes since 18:46 (now 2026-11-08 19:05:00 UTC); each line replaces that workspace\'s line:',
    '- Billing export (billing) · code · working · PR #42 · since 18:50',
    '- New: Onboarding (onboarding) · plan · idle · since 19:01',
    '- Removed: Docs refresh (docs), archived',
  ].join('\n'));
  expect(workspaceBoardChanges(rows, rows.filter(item => item.workspaceId !== 'sync'), at, later)).toContain('- Removed: Sync repair (sync), deleted');
  expect(workspaceBoardChanges(rows, rows, at, later)).toBeNull();
});
