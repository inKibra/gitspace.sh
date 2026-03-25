import { describe, expect, it } from 'bun:test';
import { AgentEventManager } from './agent-event-manager.js';

describe('AgentEventManager suppression', () => {
  it('keeps superseded sessions hidden until runtime makes them current again', () => {
    const manager = new AgentEventManager();
    manager.registerWorkspace('ws-1', '/tmp/demo/ws-1');

    manager.syncKnownSessions('ws-1', [
      { id: 'agent-old', title: 'Original session', updatedAt: '2026-03-25T00:00:00.000Z' },
      { id: 'agent-new', title: 'Forked session', updatedAt: '2026-03-25T00:00:01.000Z' },
    ]);

    expect(manager.getSnapshot()['ws-1']?.sessions.map((session) => session.id)).toEqual(['agent-old', 'agent-new']);

    manager.suppressSession('ws-1', 'agent-old');

    expect(manager.getSnapshot()['ws-1']?.sessions.map((session) => session.id)).toEqual(['agent-new']);

    manager.syncKnownSessions('ws-1', [
      { id: 'agent-old', title: 'Original session', updatedAt: '2026-03-25T00:00:02.000Z' },
      { id: 'agent-new', title: 'Forked session', updatedAt: '2026-03-25T00:00:03.000Z' },
    ]);

    expect(manager.getSnapshot()['ws-1']?.sessions.map((session) => session.id)).toEqual(['agent-new']);

    manager.syncExternalRuntimeState('ws-1', 'agent-old', {
      status: { type: 'idle' },
      pendingPermissions: [],
      pendingQuestions: [],
    });

    expect(manager.getSnapshot()['ws-1']?.sessions.map((session) => session.id).sort()).toEqual(['agent-new', 'agent-old']);
  });
});
