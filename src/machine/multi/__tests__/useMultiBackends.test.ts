/**
 * Regression tests for useMultiBackends factory callback stability.
 *
 * Background: factory callbacks (createLocalBackend, createRemoteBackend, etc.)
 * passed to useMultiBackends may be defined inline at the call site, which gives
 * them a new function reference on every render. The hook must use refs internally
 * so that reference changes alone do NOT trigger backend disconnect/reconnect.
 *
 * Regression: before the fix, passing an inline arrow function for createLocalBackend
 * caused the local backend to disconnect and reconnect on every render, leaving
 * the workspace list empty after any state update.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../../test/setup-dom.js';
import { useMultiBackends, LOCAL_BACKEND_KEY } from '../useMultiBackends.js';
import type { SessionBackend, BackendDescriptor } from '../../../session/backend.js';

beforeAll(() => setupTestDom());
afterAll(() => teardownTestDom());

// ─── Minimal mock backend ─────────────────────────────────────────────────────

function makeMockBackend(label = 'test-local'): {
  backend: SessionBackend;
  connectCount: () => number;
  disconnectCount: () => number;
} {
  let connects = 0;
  let disconnects = 0;

  const descriptor: BackendDescriptor = {
    key: LOCAL_BACKEND_KEY,
    kind: 'local',
    label,
  };

  const backend = {
    descriptor,
    connect: async () => { connects++; },
    disconnect: async () => { disconnects++; },
    // Stub required methods to no-ops
    listProjects: async () => {},
    listGithubRepos: async () => [],
    listRemoteBranches: async () => [],
    listLinearIssues: async () => [],
    listWorkspaces: async () => {},
    listSessions: async () => {},
    createProject: async () => {},
    createWorkspace: async () => {},
    deleteProject: async () => {},
    attachSession: async () => {},
    detachSession: async () => {},
    terminateSession: async () => {},
    deleteWorkspace: async () => {},
    onEvent: (_handler: unknown) => () => {},
  } as unknown as SessionBackend;

  return {
    backend,
    connectCount: () => connects,
    disconnectCount: () => disconnects,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useMultiBackends — factory callback stability', () => {
  it('calls createLocalBackend exactly once on initial render', async () => {
    const { backend } = makeMockBackend();
    const factoryCallCount = { n: 0 };
    const factory1 = () => { factoryCallCount.n++; return backend; };

    const { unmount } = renderHook(() =>
      useMultiBackends({ enabled: true, createLocalBackend: factory1 })
    );

    // Allow effects to flush
    await act(async () => {});

    expect(factoryCallCount.n).toBe(1);
    unmount();
  });

  it('does NOT call createLocalBackend again when its reference changes between renders', async () => {
    const { backend } = makeMockBackend();
    const factoryCallCount = { n: 0 };

    // Two different function references that both return the same backend
    const factory1 = () => { factoryCallCount.n++; return backend; };
    const factory2 = () => { factoryCallCount.n++; return backend; };

    const { rerender, unmount } = renderHook(
      ({ factory }) => useMultiBackends({ enabled: true, createLocalBackend: factory }),
      { initialProps: { factory: factory1 } },
    );

    await act(async () => {});
    expect(factoryCallCount.n).toBe(1);

    // Re-render with a new function reference — this is what happens when
    // the factory is defined inline at the call site (e.g. `createLocalBackend: () => ...`)
    rerender({ factory: factory2 });
    await act(async () => {});

    // Must still be 1 — the new reference must NOT have triggered another registration
    expect(factoryCallCount.n).toBe(1);
    unmount();
  });

  it('does NOT disconnect and reconnect when createLocalBackend reference changes', async () => {
    const mockInfo = makeMockBackend();

    const factory1 = () => mockInfo.backend;
    const factory2 = () => mockInfo.backend;

    const { rerender, unmount } = renderHook(
      ({ factory }) => useMultiBackends({ enabled: true, createLocalBackend: factory }),
      { initialProps: { factory: factory1 } },
    );

    await act(async () => {});
    expect(mockInfo.connectCount()).toBe(1);
    expect(mockInfo.disconnectCount()).toBe(0);

    // Reference changes — must NOT trigger disconnect/reconnect
    rerender({ factory: factory2 });
    await act(async () => {});

    expect(mockInfo.connectCount()).toBe(1);    // still just 1
    expect(mockInfo.disconnectCount()).toBe(0); // zero disconnections
    unmount();
  });

  it('DOES register a new backend when enabled changes from false to true', async () => {
    const mockInfo = makeMockBackend();
    const factoryCallCount = { n: 0 };
    const factory = () => { factoryCallCount.n++; return mockInfo.backend; };

    const { rerender, unmount } = renderHook(
      ({ enabled }) => useMultiBackends({ enabled, createLocalBackend: factory }),
      { initialProps: { enabled: false } },
    );

    await act(async () => {});
    expect(factoryCallCount.n).toBe(0); // not called while disabled

    rerender({ enabled: true });
    await act(async () => {});

    expect(factoryCallCount.n).toBe(1); // called once after enabling
    expect(mockInfo.connectCount()).toBe(1);
    unmount();
  });

  it('disconnects and unregisters when enabled changes from true to false', async () => {
    const mockInfo = makeMockBackend();
    const factory = () => mockInfo.backend;

    const { rerender, unmount } = renderHook(
      ({ enabled }) => useMultiBackends({ enabled, createLocalBackend: factory }),
      { initialProps: { enabled: true } },
    );

    await act(async () => {});
    expect(mockInfo.connectCount()).toBe(1);

    rerender({ enabled: false });
    await act(async () => {});

    // Cleanup runs — backend should have been unregistered (disconnect called)
    expect(mockInfo.disconnectCount()).toBeGreaterThanOrEqual(1);
    unmount();
  });

  it('does not register a local backend when createLocalBackend is null', async () => {
    const factoryCallCount = { n: 0 };
    const factory = () => { factoryCallCount.n++; return {} as unknown as SessionBackend; };

    const { rerender, unmount } = renderHook(
      ({ factory: f }) => useMultiBackends({ enabled: true, createLocalBackend: f }),
      { initialProps: { factory: null as typeof factory | null } },
    );

    await act(async () => {});
    expect(factoryCallCount.n).toBe(0);

    // Passing null explicitly means "no local backend" (web browser context)
    rerender({ factory: null });
    await act(async () => {});
    expect(factoryCallCount.n).toBe(0);
    unmount();
  });
});
