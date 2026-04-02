import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js';
import type { AppClient } from '../client/index.js';
import { useSessionActions } from './useSessionActions.js';





beforeAll(() => setupTestDom());

afterAll(() => teardownTestDom());

function makeClient(): AppClient {
  return {
    agentSessions: {} as any,
    workspaceLifecycle: {} as any,
    processes: {} as any,
    inbox: {} as any,
    bundles: {} as any,
    replayReview: {} as any,
    sessions: {
      attach: mock(async () => ({ ok: true as const, value: { backendKey: 'local', workspaceId: 'proj:ws-1' } })),
      cancelPendingScripts: mock(async () => ({ ok: true as const, value: { backendKey: 'local', workspaceId: 'proj:ws-1' } })),
    },
    lifecycle: {} as any,
  } as AppClient;
}

describe('useSessionActions', () => {
  it('routes attach through session client', async () => {
    const client = makeClient();
    const { result } = renderHook(() => useSessionActions({ client }));
    await result.current.attachSession({ backendKey: 'local', workspaceId: 'proj:ws-1' }, { workspaceId: 'proj:ws-1' });
    expect(client.sessions.attach).toHaveBeenCalledTimes(1);
  });
});
