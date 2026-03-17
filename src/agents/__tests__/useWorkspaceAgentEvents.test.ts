import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { Window } from 'happy-dom';
import { useWorkspaceAgentEvents } from '../useWorkspaceAgentEvents';
import type { SessionBackend } from '../../session/backend';
import type { AgentStateUpdateDelta } from '../../serve/agent-event-manager';

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

class FakeAgentEventsBackend implements Partial<SessionBackend> {
  private handlers = new Set<(delta: AgentStateUpdateDelta) => void>();

  getAgentStateSnapshot() {
    return {
      'proj:ws-1': {
        workspaceId: 'proj:ws-1',
        sessions: [{ id: 'agent-1', title: 'Agent 1' }],
        statuses: { 'agent-1': { type: 'idle' as const } },
        pendingPermissions: {},
        lastMessages: {},
      },
    };
  }

  subscribeAgentState(handler: (delta: AgentStateUpdateDelta) => void) {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async respondToAgentPermission() { return true; }

  emit(delta: AgentStateUpdateDelta) {
    for (const handler of this.handlers) {
      handler(delta);
    }
  }
}

describe('useWorkspaceAgentEvents', () => {
  it('clears agent error state after a recovery status update', async () => {
    const backend = new FakeAgentEventsBackend();
    const { result } = renderHook(() => useWorkspaceAgentEvents({ backend: backend as unknown as SessionBackend }));

    await act(async () => {
      backend.emit({
        type: 'agent_session_error',
        workspaceId: 'proj:ws-1',
        sessionId: 'agent-1',
        errorMessage: 'boom',
      });
    });

    expect(result.current.workspaceStates['proj:ws-1']['agent-1'].errorMessage).toBe('boom');

    await act(async () => {
      backend.emit({
        type: 'agent_session_status',
        workspaceId: 'proj:ws-1',
        sessionId: 'agent-1',
        status: { type: 'busy' },
      });
    });

    expect(result.current.workspaceStates['proj:ws-1']['agent-1'].errorMessage).toBeUndefined();
  });
});
