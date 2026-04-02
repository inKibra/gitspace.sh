import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import type { AppClient, AgentSessionCommandError } from '../client/index.js';
import { useInboxActions } from './useInboxActions.js';





beforeAll(() => setupTestDom());

afterAll(() => teardownTestDom());

function makeClient(overrides: Partial<AppClient['inbox']> = {}): AppClient {
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
    },
    inbox: {
      request: mock(async () => ({ ok: true as const, value: {} })),
      clear: mock(async () => ({ ok: true as const, value: {} })),
      markRead: mock(async () => ({ ok: true as const, value: { itemId: 'item-1' } })),
      respondToPermission: mock(async () => ({ ok: true as const, value: { workspaceId: 'proj:ws-1', agentSessionId: 'agent-1', permissionId: 'perm-1', response: 'allow' as const } })),
      ...overrides,
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
  };
}

describe('useInboxActions', () => {
  it('routes mark-read through the inbox client', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useInboxActions({
      client,
      flow: { showSelect: () => undefined, showInput: () => undefined },
    }));
    await result.current.markInboxRead('item-1');
    expect(client.inbox.markRead).toHaveBeenCalledWith('item-1');
  });

  it('reports inbox client errors to the UI layer', async () => {
    const onError = mock((_message: string, _error: AgentSessionCommandError) => undefined);
    const client = makeClient({
      request: mock(async () => ({
        ok: false as const,
        error: { code: 'operation-unavailable' as const, message: 'Failed to request inbox', workspaceId: '' },
      })),
    });
    const { result } = renderHook(() => useInboxActions({
      client,
      flow: { showSelect: () => undefined, showInput: () => undefined },
      onError,
    }));
    await result.current.requestInbox();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
