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

it('preserves attached session context on session exit while returning to browsing mode', () => {
  const registered = sessionEngineReducer(createInitialSessionEngineState(), {
    type: 'REGISTER_BACKEND',
    descriptor: { key: 'local', kind: 'local', label: 'Local' },
  });

  const attached = sessionEngineReducer(registered, {
    type: 'SET_ATTACHED_SESSION',
    backendKey: 'local',
    sessionId: 'session-1',
    sessionName: 'acme:ws-1:1',
    meta: { sessionName: 'acme:ws-1:1', processTitle: 'gssh space commit' },
    workspaceId: 'acme:ws-1',
  });

  const exited = sessionEngineReducer(attached, {
    type: 'SET_ATTACHED_SESSION',
    backendKey: 'local',
    sessionId: null,
    preserveContextOnExit: true,
  });

  expect(exited.backends.local.mode).toBe('browsing');
  expect(exited.backends.local.attachedSessionId).toBeNull();
  expect(exited.backends.local.attachedSessionName).toBe('acme:ws-1:1');
  expect(exited.backends.local.attachedWorkspaceId).toBe('acme:ws-1');
  expect(exited.backends.local.attachedSessionMeta).toMatchObject({
    sessionName: 'acme:ws-1:1',
    processTitle: 'gssh space commit',
  });
});

it('clears attached session context on normal detach', () => {
  const registered = sessionEngineReducer(createInitialSessionEngineState(), {
    type: 'REGISTER_BACKEND',
    descriptor: { key: 'local', kind: 'local', label: 'Local' },
  });

  const attached = sessionEngineReducer(registered, {
    type: 'SET_ATTACHED_SESSION',
    backendKey: 'local',
    sessionId: 'session-1',
    sessionName: 'acme:ws-1:1',
    workspaceId: 'acme:ws-1',
  });

  const detached = sessionEngineReducer(attached, {
    type: 'SET_ATTACHED_SESSION',
    backendKey: 'local',
    sessionId: null,
  });

  expect(detached.backends.local.mode).toBe('browsing');
  expect(detached.backends.local.attachedSessionId).toBeNull();
  expect(detached.backends.local.attachedSessionName).toBeNull();
  expect(detached.backends.local.attachedWorkspaceId).toBeNull();
  expect(detached.backends.local.attachedSessionMeta).toBeNull();
});
