import { describe, expect, it } from 'bun:test';
import { collectAgentSessionCounts, collectWorkspaceSyncIds } from '../remote-agent-browser';

describe('remote-agent-browser', () => {
  it('counts snapshot-only sessions', () => {
    expect(collectAgentSessionCounts({
      sessionsByWorkspace: {},
      workspaceStates: {},
      snapshotByWorkspace: {
        'proj:ws-1': {
          sessions: [{ id: 'agent-1' }, { id: 'agent-2' }],
        },
      },
    })).toEqual({
      'proj:ws-1': 2,
    });
  });

  it('collects sync workspace ids from all workspaces plus UI context', () => {
    expect(collectWorkspaceSyncIds(
      [{ id: 'proj:ws-1' }, { id: 'proj:ws-2' }],
      ['proj:ws-3'],
      'proj:ws-4',
    )).toEqual([
      'proj:ws-1',
      'proj:ws-2',
      'proj:ws-3',
      'proj:ws-4',
    ]);
  });
});
