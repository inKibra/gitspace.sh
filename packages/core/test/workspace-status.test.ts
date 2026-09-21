import { describe, expect, it } from 'bun:test';
import { deriveWorkspaceStatusSummary, visibleActiveWorkspaces } from '@gitspace/protocol-workspace';

describe('workspace status parity', () => {
  it('prioritizes execution failures over retained asks and outstanding work', () => {
    expect(deriveWorkspaceStatusSummary({ agents: [{ state: 'permission-needed' }, { state: 'running' }] }).primaryColor).toBe('orange');
    expect(deriveWorkspaceStatusSummary({ agents: [{ state: 'running' }, { state: 'retrying' }] }).primaryColor).toBe('red');
    expect(deriveWorkspaceStatusSummary({ agents: [{ state: 'waiting' }, { state: 'retrying' }] }).primaryColor).toBe('red');
    expect(deriveWorkspaceStatusSummary({ agents: [{ state: 'retrying' }] }).primaryColor).toBe('red');
    expect(deriveWorkspaceStatusSummary({ agents: [{ state: 'dormant' }, { state: 'closed' }] }).primaryColor).toBe('dim');
  });

  it('does not count retained asks as actionable after disconnection', () => {
    const status = deriveWorkspaceStatusSummary({ agents: [{ state: 'permission-needed', failure: { code: 'AGENT_DISCONNECTED', message: 'Connection lost' } }] });
    expect(status.primaryColor).toBe('red');
    expect(status.agents).toEqual({ green: 0, blue: 0, orange: 0, red: 1 });
  });

  it('keeps service failures separate from working agent counts', () => {
    const status = deriveWorkspaceStatusSummary({ agents: [{ state: 'running' }], services: [{ running: false, exitCode: 1 }] });
    expect(status.primaryColor).toBe('green');
    expect(status.agents.red).toBe(0);
    expect(status.services.red).toBe(1);
  });

  it('exposes active compaction without retaining it after the agent stops running', () => {
    const compaction = { detail: 'Remote compaction · attempt 2' };
    const running = deriveWorkspaceStatusSummary({ agents: [{ state: 'running', compaction }] });
    expect(running.primaryColor).toBe('green');
    expect(running.compaction).toBeDefined();
    for (const state of ['waiting', 'closed', 'archived'] as const) {
      expect(deriveWorkspaceStatusSummary({ agents: [{ state, compaction }] }).compaction).toBeUndefined();
    }
    expect(deriveWorkspaceStatusSummary({ agents: [{ state: 'running', compaction }, { state: 'permission-needed' }] }).primaryColor).toBe('orange');
  });


  it('keeps current first, hides other dim, and orders actionable then blue then green', () => {
    const status = (primaryColor: 'dim' | 'green' | 'blue' | 'orange' | 'red') => ({
      primaryColor,
      agents: { green: 0, blue: 0, orange: 0, red: 0 },
      services: { green: 0, red: 0 },
      terminals: { green: 0, red: 0 },
    });
    const ordered = visibleActiveWorkspaces([
      { id: 'green', projectId: 'b', projectName: 'Beta', name: 'Green', status: status('green') },
      { id: 'dim', projectId: 'a', projectName: 'Alpha', name: 'Dim', status: status('dim') },
      { id: 'current', projectId: 'b', projectName: 'Beta', name: 'Current', status: status('dim') },
      { id: 'blue', projectId: 'a', projectName: 'Alpha', name: 'Blue', status: status('blue') },
      { id: 'red', projectId: 'a', projectName: 'Alpha', name: 'Red', status: status('red') },
    ], 'current');
    expect(ordered.map((workspace) => workspace.id)).toEqual(['current', 'red', 'blue', 'green']);
  });
});
