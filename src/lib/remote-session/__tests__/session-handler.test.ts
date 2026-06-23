import { describe, expect, it, mock } from 'bun:test';

import { createFrame, openFrame } from '../../tmux-lite/crypto/frames.js';
import { parseRemoteMessage, serializeRemoteMessage } from '../protocol.js';
import { RemoteSessionHandler, canAccessReplayForSession, filterReplaysForSessionAccess, type RemoteClientSession } from '../session-handler.js';

describe('remote replay session access', () => {
  it('allows full access to all replays', () => {
    const replays = [
      { replayId: 'r1', sessionId: 's1' },
      { replayId: 'r2', sessionId: 's2' },
    ];

    expect(filterReplaysForSessionAccess('full', undefined, replays)).toEqual(replays);
    expect(canAccessReplayForSession('full', undefined, { sessionId: 's1' })).toBe(true);
  });

  it('limits view access to the granted session only', () => {
    const replays = [
      { replayId: 'r1', sessionId: 's1' },
      { replayId: 'r2', sessionId: 's2' },
    ];

    expect(filterReplaysForSessionAccess('view', 's2', replays)).toEqual([{ replayId: 'r2', sessionId: 's2' }]);
    expect(canAccessReplayForSession('view', 's2', { sessionId: 's2' })).toBe(true);
    expect(canAccessReplayForSession('view', 's2', { sessionId: 's1' })).toBe(false);
  });

  it('denies replay access when no session grant is present', () => {
    const replays = [{ replayId: 'r1', sessionId: 's1' }];
    expect(filterReplaysForSessionAccess('view', undefined, replays)).toEqual([]);
    expect(canAccessReplayForSession('view', undefined, { sessionId: 's1' })).toBe(false);
    expect(canAccessReplayForSession(undefined, undefined, { sessionId: 's1' })).toBe(false);
  });
});

function makeRemoteOperation(operationId: string, state: 'running' | 'succeeded' = 'succeeded', updatedAt = Date.now()) {
  return {
    operationId,
    kind: 'workspace.delete' as const,
    scope: { projectName: 'project', workspaceId: `project:${operationId}`, workspaceName: operationId },
    state,
    startedAt: updatedAt - 1,
    updatedAt,
  };
}

describe('remote operation retention and dismissal', () => {
  it('omits dismissed terminal operations from later snapshots for that connection', async () => {
    const handler = new RemoteSessionHandler();
    const internal = handler as unknown as {
      operations: Map<string, ReturnType<typeof makeRemoteOperation>>;
      dismissedOperationIdsByConnection: Map<string, Set<string>>;
    };
    internal.operations.set('terminal-1', makeRemoteOperation('terminal-1'));
    internal.operations.set('running-1', makeRemoteOperation('running-1', 'running'));
    internal.dismissedOperationIdsByConnection.set('client-1', new Set(['terminal-1']));

    const snapshots: unknown[] = [];
    await handler.onClientEntersBrowsing('client-1', async (message) => {
      snapshots.push(message);
    });

    expect(snapshots).toContainEqual({
      type: 'operation_snapshot',
      operations: [makeRemoteOperation('running-1', 'running', internal.operations.get('running-1')!.updatedAt)],
    });
  });

  it('prunes old terminal operations without pruning running operations', () => {
    const handler = new RemoteSessionHandler();
    const internal = handler as unknown as {
      operations: Map<string, ReturnType<typeof makeRemoteOperation>>;
      pruneTerminalOperations(): void;
    };
    internal.operations.set('old-running', makeRemoteOperation('old-running', 'running', 1));
    for (let index = 0; index < 105; index += 1) {
      internal.operations.set(`terminal-${index}`, makeRemoteOperation(`terminal-${index}`, 'succeeded', index + 2));
    }

    internal.pruneTerminalOperations();

    expect(internal.operations.has('old-running')).toBe(true);
    expect([...internal.operations.values()].filter((operation) => operation.state !== 'running')).toHaveLength(100);
    expect(internal.operations.has('terminal-0')).toBe(false);
    expect(internal.operations.has('terminal-104')).toBe(true);
  });
});


describe('remote /space command responses', () => {
  it('acknowledges run_space_command and emits encrypted final operation event', async () => {
    mock.module('@oh-my-pi/pi-coding-agent/exec/exec', () => ({
      execCommand: async () => ({ stdout: 'event output', stderr: '', code: 0, killed: false }),
    }));

    const handler = new RemoteSessionHandler();
    const sendKey = new Uint8Array(32).fill(7);
    const receiveKey = new Uint8Array(32).fill(11);
    const session: RemoteClientSession = {
      connectionId: 'client-1',
      state: 'browsing',
      accessType: 'full',
      sessionKeys: {
        sendKey,
        receiveKey,
        sessionId: 'session-keys-1',
      },
    };

    const request = {
      type: 'run_space_command' as const,
      requestId: 'request-1',
      target: {
        workspaceId: 'project:workspace',
        workspaceName: 'workspace',
        projectName: 'project',
        workspacePath: process.cwd(),
      },
      argsText: 'events list',
    };

    const requestFrame = createFrame(0, new TextEncoder().encode(serializeRemoteMessage(request)), receiveKey);
    const responses: Uint8Array[] = [];
    await handler.onClientEntersBrowsing('client-1', async (msg) => {
      responses.push(createFrame(0, new TextEncoder().encode(serializeRemoteMessage(msg)), sendKey));
    });
    responses.length = 0;

    await handler.handleMessage(session, requestFrame, (data) => {
      responses.push(data);
    });

    for (let i = 0; i < 5 && responses.length < 3; i += 1) {
      await Bun.sleep(0);
    }
    expect(responses.length).toBeGreaterThanOrEqual(2);
    const messages = responses.map((response) => {
      expect(new TextDecoder().decode(response).startsWith('{')).toBe(false);
      const opened = openFrame(response, sendKey);
      expect(opened).not.toBeNull();
      if (!opened) throw new Error('Expected encrypted response to decrypt');
      expect(opened.streamId).toBe(0);
      return parseRemoteMessage(new TextDecoder().decode(opened.data));
    });
    const accepted = messages.find((message) => message?.type === 'operation_accepted');
    expect(accepted).toMatchObject({
      type: 'operation_accepted',
      requestId: 'request-1',
      operation: { operationId: 'request-1', kind: 'space.command', state: 'running' },
    });

    const message = messages.find((candidate) =>
      candidate?.type === 'operation_event'
      && candidate.event.type === 'operation_succeeded'
      && candidate.event.operation.operationId === 'request-1'
    );
    expect(message).toMatchObject({
      type: 'operation_event',
      event: {
        type: 'operation_succeeded',
        operation: {
          operationId: 'request-1',
          kind: 'space.command',
          state: 'succeeded',
          result: {
            type: 'run_space_command_response',
            requestId: 'request-1',
            output: 'Output from `space events list` in the current workspace:\n\nevent output',
          },
        },
      },
    });
  });
});
