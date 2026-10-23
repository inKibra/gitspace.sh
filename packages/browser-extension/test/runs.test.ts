import { describe, expect, it } from 'bun:test';
import { groupTitle, runLogEntry, type LiveRun } from '../src/runs.js';
import { restoredGroup } from '../src/commands.js';

describe('a workspace group title while scripts run', () => {
  it('is marked while one runs and restored after', () => {
    expect(groupTitle('Checkout', true)).toBe('▶ Checkout');
    expect(groupTitle('▶ Checkout', true)).toBe('▶ Checkout');
    expect(groupTitle('▶ Checkout', false)).toBe('Checkout');
    expect(groupTitle('Checkout', false)).toBe('Checkout');
  });

  it('still names its group after Chrome restored it marked', () => {
    expect(restoredGroup([{ id: 9, title: '▶ Checkout', color: 'blue' }], 'Checkout', 'blue', [])).toBe(9);
  });
});

describe('the run log', () => {
  it('records how a script ended, what it sent and what was refused', () => {
    const run: LiveRun = {
      body: { scope: { attemptId: 'attempt', projectId: 'project', workspaceId: 'workspace' }, command: { grant: { body: { groupName: 'Checkout' } } } },
      scriptSha256: 'a'.repeat(64), sites: ['app.example'], startedAt: '2026-10-23T10:00:00.000Z', commands: 12, refused: 2,
    };
    expect(runLogEntry(run, 'stopped', '2026-10-23T10:00:05.000Z')).toEqual({
      attemptId: 'attempt', workspace: { projectId: 'project', workspaceId: 'workspace', groupName: 'Checkout' },
      scriptSha256: 'a'.repeat(64), sites: ['app.example'], startedAt: '2026-10-23T10:00:00.000Z', endedAt: '2026-10-23T10:00:05.000Z', endReason: 'stopped', commands: 12, refused: 2,
    });
  });
});
