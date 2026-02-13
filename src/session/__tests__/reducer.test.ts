import { describe, expect, it } from 'bun:test';
import {
  createInitialSessionEngineState,
  sessionEngineReducer,
} from '../reducer';

describe('sessionEngineReducer', () => {
  it('registers backend and sets first backend active', () => {
    const initial = createInitialSessionEngineState();
    const next = sessionEngineReducer(initial, {
      type: 'REGISTER_BACKEND',
      descriptor: {
        key: 'local',
        kind: 'local',
        label: 'Local',
      },
    });

    expect(next.backendOrder).toEqual(['local']);
    expect(next.activeBackendKey).toBe('local');
    expect(next.backends.local.descriptor.label).toBe('Local');
  });

  it('keeps backend state isolated between multiple backends', () => {
    const registered = sessionEngineReducer(
      sessionEngineReducer(createInitialSessionEngineState(), {
        type: 'REGISTER_BACKEND',
        descriptor: { key: 'local', kind: 'local', label: 'Local' },
      }),
      {
        type: 'REGISTER_BACKEND',
        descriptor: {
          key: 'remote:relay:machine-a',
          kind: 'remote',
          label: 'Machine A',
          machineId: 'machine-a',
          relayUrl: 'wss://relay.example/ws',
        },
      }
    );

    const withProjects = sessionEngineReducer(registered, {
      type: 'SET_PROJECTS',
      backendKey: 'remote:relay:machine-a',
      projects: [
        {
          name: 'core',
          repository: 'owner/core',
          workspaceCount: 2,
          isCurrent: true,
        },
      ],
    });

    expect(withProjects.backends.local.projects).toEqual([]);
    expect(withProjects.backends['remote:relay:machine-a'].projects).toHaveLength(1);
  });

  it('switches active backend and preserves each backend state', () => {
    const state = sessionEngineReducer(
      sessionEngineReducer(createInitialSessionEngineState(), {
        type: 'REGISTER_BACKEND',
        descriptor: { key: 'local', kind: 'local', label: 'Local' },
      }),
      {
        type: 'REGISTER_BACKEND',
        descriptor: { key: 'remote:relay:machine-a', kind: 'remote', label: 'Machine A' },
      }
    );

    const switched = sessionEngineReducer(state, {
      type: 'SET_ACTIVE_BACKEND',
      backendKey: 'remote:relay:machine-a',
    });

    expect(switched.activeBackendKey).toBe('remote:relay:machine-a');
    expect(switched.backends.local.descriptor.label).toBe('Local');
    expect(switched.backends['remote:relay:machine-a'].descriptor.label).toBe('Machine A');
  });
});
