import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import type { AppClient, AgentSessionCommandError } from '../client/index.js';
import { AppClientProvider } from './AppClientProvider.js';
import { useAppClient } from './useAppClient.js';
import { useAgentSessionActions } from './useAgentSessionActions.js';





beforeAll(() => setupTestDom());

afterAll(() => teardownTestDom());

function makeClient(overrides: Partial<AppClient['agentSessions']> = {}): AppClient {
  return {
    agentSessions: {
      open: mock(async () => ({
        ok: true as const,
        value: {
          workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' },
          agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' },
        },
      })),
      createAndOpen: mock(async () => ({
        ok: true as const,
        value: {
          workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' },
          agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-created' },
        },
      })),
      stopAgentTurn: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      kill: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      close: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      archive: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      restore: mock(async () => ({ ok: true as const, value: { workspaceRef: { backendKey: 'local', workspaceId: 'proj:ws-1' }, agentSessionRef: { backendKey: 'local', workspaceId: 'proj:ws-1', agentSessionId: 'agent-1' } } })),
      ...overrides,
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

describe('useAppClient', () => {
  it('reads the client from AppClientProvider', () => {
    const client = makeClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <AppClientProvider client={client}>{children}</AppClientProvider>
    );

    const { result } = renderHook(() => useAppClient(), { wrapper });

    expect(result.current).toBe(client);
  });
});

describe('useAgentSessionActions', () => {
  it('shows creating state before closing into attach flow', async () => {
    const showInputCalls: Array<{ onSubmit: (value: string) => Promise<void> | void }> = [];
    const showLoading = mock(() => undefined);
    const close = mock(() => undefined);
    const beforeOpen = mock(() => undefined);
    const onOpenSuccess = mock(() => undefined);
    const client = makeClient();
    const attachOptions = { cols: 120, rows: 40 };

    const { result } = renderHook(() => useAgentSessionActions({
      client,
      flow: {
        showInput: (options) => {
          showInputCalls.push({ onSubmit: options.onSubmit });
        },
        showLoading,
        close,
      },
      beforeOpen,
      onOpenSuccess,
      attachOptions,
    }));

    result.current.createAndOpen('proj:ws-1');
    expect(showInputCalls.length).toBe(1);

    await showInputCalls[0]?.onSubmit('  investigate auth bug  ');

    expect(beforeOpen).toHaveBeenCalledTimes(1);
    expect(showLoading).toHaveBeenCalledWith({
      title: 'Creating Agent Session',
      message: 'Creating investigate auth bug...',
    });
    expect(client.agentSessions.createAndOpen).toHaveBeenCalledWith({
      workspaceId: 'proj:ws-1',
      title: 'investigate auth bug',
      attachOptions,
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(onOpenSuccess).toHaveBeenCalledTimes(1);
  });

  it('maps client failures to UI-facing error messages', async () => {
    const onError = mock((_message: string, _error: AgentSessionCommandError) => undefined);
    const client = makeClient({
      open: mock(async () => ({
        ok: false as const,
        error: {
          code: 'ambiguous-backend' as const,
          message: 'Workspace proj:ws-1 exists on multiple backends',
          workspaceId: 'proj:ws-1',
          candidateBackendKeys: ['local', 'remote:machine-1'],
        },
      })),
    });

    const { result } = renderHook(() => useAgentSessionActions({
      client,
      flow: { showInput: () => undefined },
      onError,
    }));

    const openResult = await result.current.open('proj:ws-1', 'agent-1');

    expect(openResult).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(
      "Failed to open agent session: workspace proj:ws-1 exists on multiple machines; select the workspace's machine first.",
    );
  });

  it('calls onOpenError when createAndOpen fails', async () => {
    const showInputCalls: Array<{ onSubmit: (value: string) => Promise<void> | void }> = [];
    const showLoading = mock(() => undefined);
    const close = mock(() => undefined);
    const onOpenError = mock((_error: AgentSessionCommandError) => undefined);
    const onError = mock((_message: string, _error: AgentSessionCommandError) => undefined);
    const client = makeClient({
      createAndOpen: mock(async () => ({
        ok: false as const,
        error: {
          code: 'workspace-not-found' as const,
          message: 'workspace missing',
          workspaceId: 'proj:ws-1',
        },
      })),
    });

    const { result } = renderHook(() => useAgentSessionActions({
      client,
      flow: {
        showInput: (options) => {
          showInputCalls.push({ onSubmit: options.onSubmit });
        },
        showLoading,
        close,
      },
      onError,
    }));

    result.current.createAndOpen('proj:ws-1', { onOpenError });
    expect(showInputCalls.length).toBe(1);

    await showInputCalls[0]?.onSubmit('broken');

    expect(close).toHaveBeenCalledTimes(1);
    expect(onOpenError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
