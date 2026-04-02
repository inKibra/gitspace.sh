import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import type { AppClient, AgentSessionCommandError } from '../client/index.js';
import { useReplayReviewActions } from './useReplayReviewActions.js';





beforeAll(() => setupTestDom());

afterAll(() => teardownTestDom());

function makeClient(overrides: Partial<AppClient['replayReview']> = {}): AppClient {
  return {
    agentSessions: {} as any,
    workspaceLifecycle: {} as any,
    processes: {} as any,
    inbox: {} as any,
    bundles: {} as any,
    replayReview: {
      sendReviewRequest: mock(async () => ({ ok: true as const, value: { ok: true } as any })),
      dismissReplay: mock(async () => ({ ok: true as const, value: { replayId: 'replay-1' } })),
      undismissReplay: mock(async () => ({ ok: true as const, value: { replayId: 'replay-1' } })),
      cancelReplayRequests: mock(() => undefined),
      getReplayFrame: mock(async () => ({ ok: true as const, value: {} as any })),
      getReplayTimeline: mock(async () => ({ ok: true as const, value: {} as any })),
      ...overrides,
    },
    sessions: {} as any,
    lifecycle: {} as any,
  } as AppClient;
}

describe('useReplayReviewActions', () => {
  it('routes review requests through client', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useReplayReviewActions({ client }));
    await result.current.sendReviewRequest('local', 'proj:ws-1', { op: 'status', projectName: 'proj', workspaceName: 'proj:ws-1' } as any);
    expect(client.replayReview.sendReviewRequest).toHaveBeenCalledTimes(1);
  });

  it('reports replay errors', async () => {
    const onError = mock((_message: string, _error: AgentSessionCommandError) => undefined);
    const client = makeClient({
      dismissReplay: mock(async () => ({ ok: false as const, error: { code: 'operation-unavailable' as const, message: 'Failed to dismiss replay', workspaceId: '' } })),
    });
    const { result } = renderHook(() => useReplayReviewActions({ client, onError }));
    await expect(result.current.toggleReplayDismissed('local', 'replay-1', false)).rejects.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
