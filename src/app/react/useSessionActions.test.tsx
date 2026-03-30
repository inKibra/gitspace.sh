import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { Window } from 'happy-dom';
import type { AppClient } from '../client/index.js';
import { useSessionActions } from './useSessionActions.js';

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
