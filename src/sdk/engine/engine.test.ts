import { describe, it, expect } from 'bun:test';
import { GitSpaceEngine, LOCAL_BACKEND_KEY } from './engine.js';
import type { SessionBackend } from '../../session/backend.js';
import type { BackendEvent } from '../../session/events.js';
import type { MultiMachineState } from '../../machine/multi/types.js';

// ─── Mock backend factory ────────────────────────────────────────────────────

/**
 * Returns a SessionBackend stub plus test-side helpers for inspecting calls
 * and injecting events into the engine.
 *
 * The `emit` helper fires events through the handler registered via `onEvent`,
 * which is how the BackendManager feeds events into the engine's reducer.
 */
function createMockBackend(key = LOCAL_BACKEND_KEY) {
  let eventHandler: ((event: BackendEvent) => void) | null = null;
  let connectCalled = false;
  let disconnectCalled = false;

  const backend: SessionBackend = {
    descriptor: { key, kind: 'local', label: 'Local' },

    connect: async () => { connectCalled = true; },
    disconnect: async () => { disconnectCalled = true; },

    onEvent: (handler) => {
      eventHandler = handler;
      return () => { eventHandler = null; };
    },

    // All required list/action stubs — return the documented empty/void values.
    listProjects: async () => undefined,
    listGithubRepos: async () => [],
    listRemoteBranches: async () => [],
    listLinearIssues: async () => [],
    listWorkspaces: async () => undefined,
    listSessions: async () => undefined,

    createProject: async () => undefined,
    createWorkspace: async () => undefined,
    deleteProject: async () => undefined,
    attachSession: async () => undefined,
    detachSession: async () => undefined,
    terminateSession: async () => undefined,
    deleteWorkspace: async () => undefined,

    getBundleRefreshPlan: async () => { throw new Error('not used in these tests'); },
    applyBundleRefresh: async () => undefined,
    getBundleConfigState: async () => { throw new Error('not used in these tests'); },
    applyBundleConfigUpdate: async () => undefined,

    requestInbox: async () => undefined,
    clearInbox: async () => undefined,
    markInboxRead: async () => undefined,
    getNotificationConfig: async () => undefined,
    updateNotificationConfig: async () => undefined,

    sendReviewRequest: async () => { throw new Error('not used in these tests'); },

    subscribeAgentState: () => () => undefined,
    getAgentStateSnapshot: () => ({}),
    respondToAgentPermission: async () => false,
    getAgentSessionPreference: async () => null,
    setAgentSessionPreference: async () => undefined,
  };

  return {
    backend,
    get connectCalled() { return connectCalled; },
    get disconnectCalled() { return disconnectCalled; },
    /** Fire a BackendEvent as if it arrived from the real backend transport. */
    emit: (event: BackendEvent) => { eventHandler?.(event); },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GitSpaceEngine', () => {
  it('start() connects the local backend', async () => {
    const mock = createMockBackend();
    const engine = new GitSpaceEngine({
      platform: { createLocalBackend: () => mock.backend },
    });

    expect(mock.connectCalled).toBe(false);
    await engine.start();
    expect(mock.connectCalled).toBe(true);

    await engine.destroy();
  });

  it('getState() returns the local backend in byBackend after start', async () => {
    const mock = createMockBackend();
    const engine = new GitSpaceEngine({
      platform: { createLocalBackend: () => mock.backend },
    });

    await engine.start();
    const state: MultiMachineState = engine.getState();

    // The backend should be registered and appear in backendOrder
    expect(state.backendOrder).toContain(LOCAL_BACKEND_KEY);
    expect(state.byBackend[LOCAL_BACKEND_KEY]).toBeDefined();
    // Initial status is 'disconnected' — mock connect() doesn't emit a status event
    expect(state.byBackend[LOCAL_BACKEND_KEY]?.status).toBe('disconnected');
    // activeBackendKey is set to the first registered backend
    expect(state.activeBackendKey).toBe(LOCAL_BACKEND_KEY);

    await engine.destroy();
  });

  it('subscribe() listener fires when a backend event changes state', async () => {
    const mock = createMockBackend();
    const engine = new GitSpaceEngine({
      platform: { createLocalBackend: () => mock.backend },
    });

    await engine.start();

    const received: MultiMachineState[] = [];
    const unsub = engine.subscribe((s) => received.push(s));

    // Emit a 'connected' status event — the engine reducer maps this via
    // SET_BACKEND_STATUS and rebuilds the projected MultiMachineState.
    mock.emit({ type: 'status', status: 'connected' });
    // Engine batches notifications via queueMicrotask — flush it
    await new Promise(r => queueMicrotask(r));

    expect(received).toHaveLength(1);
    expect(received[0]?.byBackend[LOCAL_BACKEND_KEY]?.status).toBe('connected');

    unsub();
    // After unsubscribing, further events must not reach the listener.
    mock.emit({ type: 'status', status: 'disconnected' });
    await new Promise(r => queueMicrotask(r));
    expect(received).toHaveLength(1);

    await engine.destroy();
  });

  it('destroy() disconnects all registered backends', async () => {
    const mock = createMockBackend();
    const engine = new GitSpaceEngine({
      platform: { createLocalBackend: () => mock.backend },
    });

    await engine.start();
    expect(mock.disconnectCalled).toBe(false);

    await engine.destroy();
    expect(mock.disconnectCalled).toBe(true);
  });

  it('start() can be called again after destroy() (React StrictMode compat)', async () => {
    const mock = createMockBackend();
    const engine = new GitSpaceEngine({
      platform: { createLocalBackend: () => mock.backend },
    });

    await engine.start();
    await engine.destroy();
    // React StrictMode calls unmount→mount, so start() must work after destroy().
    await engine.start();
    expect(engine.getState().backendOrder).toContain('local');
    await engine.destroy();
  });
});
