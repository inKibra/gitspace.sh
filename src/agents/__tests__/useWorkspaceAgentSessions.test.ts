import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { Window } from 'happy-dom';
import { useWorkspaceAgentSessions } from '../useWorkspaceAgentSessions';
import type { SessionBackend } from '../../session/backend';
import type { SessionStatus } from '../opencode-event-types';

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

class FakeAgentBackend implements Partial<SessionBackend> {
  sessionsByWorkspace = new Map<string, Array<{ id: string; title: string; updatedAt?: string }>>();
  statusByWorkspace = new Map<string, Record<string, SessionStatus>>();

  constructor() {
    this.sessionsByWorkspace.set('proj:ws-1', [
      { id: 'agent-1', title: 'Investigate auth', updatedAt: '2026-03-15T00:00:00.000Z' },
    ]);
    this.statusByWorkspace.set('proj:ws-1', {
      'agent-1': { type: 'idle' },
    });
  }

  getAgentStateSnapshot() {
    const result: Record<string, { workspaceId: string; sessions: Array<{ id: string; title: string }>; statuses: Record<string, SessionStatus>; pendingPermissions: Record<string, []>; lastMessages: Record<string, string> }> = {};
    for (const [workspaceId, statuses] of this.statusByWorkspace) {
      const sessions = this.sessionsByWorkspace.get(workspaceId) ?? [];
      result[workspaceId] = {
        workspaceId,
        sessions: sessions.map((session) => ({ id: session.id, title: session.title })),
        statuses,
        pendingPermissions: {},
        lastMessages: {},
      };
    }
    return result;
  }

  async getKnownAgentSessions(workspaceId: string) {
    return this.sessionsByWorkspace.get(workspaceId) ?? [];
  }

  async listAgentSessions(workspaceId: string) {
    return this.sessionsByWorkspace.get(workspaceId) ?? [];
  }

  async createAgentSession(workspaceId: string, title?: string) {
    const sessions = this.sessionsByWorkspace.get(workspaceId) ?? [];
    const next = [...sessions, { id: `agent-${sessions.length + 1}`, title: title ?? 'New Session' }];
    this.sessionsByWorkspace.set(workspaceId, next);
    return next;
  }

  async abortAgentSession(workspaceId: string, sessionId: string) {
    const sessions = this.sessionsByWorkspace.get(workspaceId) ?? [];
    this.sessionsByWorkspace.set(workspaceId, sessions.filter((session) => session.id !== sessionId));
    return true;
  }
}

describe('useWorkspaceAgentSessions', () => {
  it('loads known sessions through bound backend methods', async () => {
    const backend = new FakeAgentBackend();
    const { result } = renderHook(() => useWorkspaceAgentSessions({ backend: backend as unknown as SessionBackend }));

    await act(async () => {
      await result.current.loadWorkspaceSessions('proj:ws-1');
    });

    expect(result.current.sessionsByWorkspace['proj:ws-1']).toEqual([
      expect.objectContaining({ id: 'agent-1', title: 'Investigate auth', status: { type: 'idle' } }),
    ]);
  });

  it('creates sessions through the hook without losing backend this binding', async () => {
    const backend = new FakeAgentBackend();
    const { result } = renderHook(() => useWorkspaceAgentSessions({ backend: backend as unknown as SessionBackend }));

    await act(async () => {
      await result.current.createSession('proj:ws-1', 'New debug session');
    });

    expect(result.current.sessionsByWorkspace['proj:ws-1']).toEqual([
      expect.objectContaining({ id: 'agent-1', title: 'Investigate auth' }),
      expect.objectContaining({ id: 'agent-2', title: 'New debug session' }),
    ]);
  });

  it('aborts sessions through the hook without losing backend this binding', async () => {
    const backend = new FakeAgentBackend();
    const { result } = renderHook(() => useWorkspaceAgentSessions({ backend: backend as unknown as SessionBackend }));

    await act(async () => {
      await result.current.loadWorkspaceSessions('proj:ws-1');
      await result.current.abortSession('proj:ws-1', 'agent-1');
    });

    expect(result.current.sessionsByWorkspace['proj:ws-1']).toEqual([]);
  });
});
