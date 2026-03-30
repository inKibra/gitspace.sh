import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { Window } from 'happy-dom';
import type { AppClient, AgentSessionCommandError } from '../client/index.js';
import { useProcessActions } from './useProcessActions.js';

const domWindow = new Window();
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

beforeAll(() => {
  // @ts-expect-error test DOM setup
  globalThis.window = domWindow;
  // @ts-expect-error test DOM setup
  globalThis.document = domWindow.document;
});

afterAll(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
});

function makeClient(overrides: Partial<AppClient['processes']> = {}): AppClient {
  return {
    agentSessions: {
      open: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      createAndOpen: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-created' } } })),
      abort: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      close: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      archive: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      restore: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
    },
    workspaceLifecycle: {
      setStatus: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, phase: 'code' as const } })),
      deleteWorkspace: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, params: { scriptPolicy: 'auto' as const } } })),
    },
    processes: {
      start: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, processName: 'web', instance: 1 } })),
      stop: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, processName: 'web' } })),
      ...overrides,
    },
    inbox: {
      request: mock(async () => ({ ok: true as const, value: {} })),
      clear: mock(async () => ({ ok: true as const, value: {} })),
      markRead: mock(async () => ({ ok: true as const, value: { itemId: 'item-1' } })),
      respondToPermission: mock(async () => ({ ok: true as const, value: { workspaceId: 'proj:ws-1', agentSessionId: 'agent-1', permissionId: 'perm-1', response: 'allow' as const } })),
    },
    bundles: {
      getRefreshPlan: mock(async () => ({ ok: true as const, value: {} as any })),
      applyRefresh: mock(async () => ({ ok: true as const, value: { backendKey: 'local', workspaceId: 'proj:ws-1' } })),
      getConfigState: mock(async () => ({ ok: true as const, value: {} as any })),
      applyConfigUpdate: mock(async () => ({ ok: true as const, value: { backendKey: 'local', workspaceId: 'proj:ws-1' } })),
    },
    replayReview: {
      sendReviewRequest: mock(async () => ({ ok: true as const, value: {} as any })),
      dismissReplay: mock(async () => ({ ok: true as const, value: { replayId: 'replay-1' } })),
      undismissReplay: mock(async () => ({ ok: true as const, value: { replayId: 'replay-1' } })),
      cancelReplayRequests: mock(() => undefined),
      getReplayFrame: mock(async () => ({ ok: true as const, value: {} as any })),
      getReplayTimeline: mock(async () => ({ ok: true as const, value: {} as any })),
    },
    sessions: {
      attach: mock(async () => ({ ok: true as const, value: { backendKey: 'local', workspaceId: 'proj:ws-1' } })),
      cancelPendingScripts: mock(async () => ({ ok: true as const, value: { backendKey: 'local', workspaceId: 'proj:ws-1' } })),
    },
    lifecycle: {} as any,
  } as AppClient;
}

describe('useProcessActions', () => {
  it('routes start requests through the process client', () => {
    const client = makeClient();
    const { result } = renderHook(() => useProcessActions({
      client,
      flow: { showConfirm: () => undefined },
      sessions: [],
      attachSession: async () => undefined,
      onStartProcessError: () => undefined,
      onStopProcessError: () => undefined,
      onStartProcessAttachError: () => undefined,
      onAttachError: () => undefined,
    }));

    result.current.handleStartProcess({ workspaceId: 'proj:ws-1', processName: 'web', instance: 1 });

    expect(client.processes.start).toHaveBeenCalledWith('proj:ws-1', 'web', 1);
  });

  it('reports stop client errors through the shared hook path', async () => {
    const onStopProcessError = mock((_error: unknown) => undefined);
    const onClientError = mock((_message: string, _error: AgentSessionCommandError) => undefined);
    const client = makeClient({
      stop: mock(async () => ({
        ok: false as const,
        error: {
          code: 'operation-unavailable' as const,
          message: 'Process stop is unavailable',
          workspaceId: 'proj:ws-1',
        },
      })),
    });

    const { result } = renderHook(() => useProcessActions({
      client,
      flow: { showConfirm: () => undefined },
      sessions: [],
      attachSession: async () => undefined,
      onStartProcessError: () => undefined,
      onStopProcessError,
      onStartProcessAttachError: () => undefined,
      onAttachError: () => undefined,
      onClientError,
    }));

    result.current.handleStopProcess({ workspaceId: 'proj:ws-1', processName: 'web' });
    await Promise.resolve();
    await Promise.resolve();

    expect(onClientError).toHaveBeenCalledTimes(1);
    expect(onStopProcessError).toHaveBeenCalledTimes(1);
  });
});
