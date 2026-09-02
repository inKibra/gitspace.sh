import { describe, expect, it } from 'bun:test';
import { deriveWorkspaceStatusSummary, visibleActiveWorkspaces } from '../src/index.js';

describe('workspace status parity', () => {
  it('preserves orange, green, blue, red, dim precedence', () => {
    expect(deriveWorkspaceStatusSummary({ agents: [{ state: 'permission-needed' }, { state: 'running' }] }).primaryColor).toBe('orange');
    expect(deriveWorkspaceStatusSummary({ agents: [{ state: 'running' }, { state: 'retrying', errorMessage: 'quota exceeded' }] }).primaryColor).toBe('green');
    expect(deriveWorkspaceStatusSummary({ agents: [{ state: 'waiting' }, { state: 'retrying', errorMessage: 'network timeout' }] }).primaryColor).toBe('blue');
    expect(deriveWorkspaceStatusSummary({ agents: [{ state: 'retrying', errorMessage: 'provider unauthorized' }] }).primaryColor).toBe('red');
    expect(deriveWorkspaceStatusSummary({ agents: [{ state: 'dormant' }, { state: 'closed' }] }).primaryColor).toBe('dim');
  });

  it('downgrades noisy LSP retries to blue', () => {
    const status = deriveWorkspaceStatusSummary({ agents: [{ state: 'retrying', errorMessage: 'LSP language server unavailable' }] });
    expect(status).toMatchObject({ primaryColor: 'blue', agents: { blue: 1, red: 0 } });
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
