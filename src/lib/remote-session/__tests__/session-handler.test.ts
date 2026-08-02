import { describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { createFrame, openFrame } from '../../tmux-lite/crypto/frames.js';
import { decodeRouterMessages, encodeRouterMessage, type Command, type Response } from '../../tmux-lite/protocol.js';
import { parseRemoteMessage, serializeRemoteMessage } from '../protocol.js';
import { RemoteSessionHandler, canAccessReplayForSession, filterReplaysForSessionAccess, type RemoteClientSession } from '../session-handler.js';

interface ControlledTimer {
  callback: () => void;
  cancelled: boolean;
}

interface ControlledTimers {
  advance(): void;
  restore(): void;
}

interface ControlledReplyServer {
  requestReceived: Promise<Command>;
  reply(response: Response): void;
  stop(): void;
}

function installControlledTimers(): ControlledTimers {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set<ControlledTimer>();

  globalThis.setTimeout = ((callback: () => void) => {
    const timer: ControlledTimer = { callback, cancelled: false };
    timers.add(timer);
    return timer as unknown as number;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: unknown) => {
    if (typeof timer === 'object' && timer !== null && timers.has(timer as ControlledTimer)) {
      (timer as ControlledTimer).cancelled = true;
    }
  }) as typeof clearTimeout;

  return {
    advance() {
      for (const timer of timers) {
        if (!timer.cancelled) {
          timer.cancelled = true;
          timer.callback();
        }
      }
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

function listenForTmuxReply(socketPath: string): ControlledReplyServer {
  let resolveRequest: ((command: Command) => void) | undefined;
  const requestReceived = new Promise<Command>((resolve) => {
    resolveRequest = resolve;
  });
  let reply: ((response: Response) => void) | undefined;
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, data) {
        buffer = Buffer.concat([buffer, Buffer.from(data)]);
        const decoded = decodeRouterMessages(buffer);
        buffer = decoded.remaining;
        const command = decoded.messages[0] as Command | undefined;
        if (!command) return;
        reply = (response) => socket.write(encodeRouterMessage(response));
        resolveRequest?.(command);
      },
    },
  });

  return {
    requestReceived,
    reply(response) {
      if (!reply) throw new Error('Expected a tmux command before replying');
      reply(response);
    },
    stop() {
      server.stop(true);
    },
  };
}

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

describe('remote agent-shake command dispatch', () => {
  it('uses the unbounded socket fallback and returns the delayed tmux result', async () => {
    const envKeys = [
      'TMUX_LITE_SANDBOX',
      'TMUX_LITE_SOCKET',
      'TMUX_LITE_SESSION_DIR',
      'TMUX_LITE_PID_FILE',
    ] as const;
    const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    const testDir = mkdtempSync(join(tmpdir(), 'remote-shake-timeout-'));
    const socketPath = join(testDir, 'router.sock');
    const timers = installControlledTimers();
    let control: ControlledReplyServer | undefined;

    try {
      delete process.env.TMUX_LITE_SANDBOX;
      process.env.TMUX_LITE_SOCKET = socketPath;
      process.env.TMUX_LITE_SESSION_DIR = testDir;
      process.env.TMUX_LITE_PID_FILE = join(testDir, 'router.pid');
      control = listenForTmuxReply(socketPath);

      const handler = new RemoteSessionHandler();
      const sendKey = new Uint8Array(32).fill(17);
      const receiveKey = new Uint8Array(32).fill(23);
      const session: RemoteClientSession = {
        connectionId: 'shake-client',
        state: 'browsing',
        accessType: 'full',
        sessionKeys: {
          sendKey,
          receiveKey,
          sessionId: 'shake-session-keys',
        },
      };
      const request = {
        type: 'shake_agent_session' as const,
        requestId: 'shake-request',
        target: {
          workspaceId: 'project:workspace',
          workspaceName: 'workspace',
          projectName: 'project',
          workspacePath: '/workspace',
        },
        agentSessionId: 'agent-1',
        mode: 'elide' as const,
      };
      const responses: Uint8Array[] = [];
      const requestFrame = createFrame(0, new TextEncoder().encode(serializeRemoteMessage(request)), receiveKey);
      const pending = handler.handleMessage(session, requestFrame, (data) => {
        responses.push(data);
      });

      await expect(control.requestReceived).resolves.toEqual({
        type: 'agent-shake',
        target: request.target,
        agentSessionId: 'agent-1',
        mode: 'elide',
      });
      timers.advance();
      const result = {
        mode: 'elide' as const,
        toolResultsDropped: 3,
        blocksDropped: 2,
        tokensFreed: 120,
      };
      control.reply({ type: 'agent-shake-result', result });
      await pending;

      expect(responses).toHaveLength(1);
      const responseFrame = openFrame(responses[0], sendKey);
      expect(responseFrame).not.toBeNull();
      if (!responseFrame) throw new Error('Expected encrypted command response');
      expect(parseRemoteMessage(new TextDecoder().decode(responseFrame.data))).toEqual({
        type: 'command_response',
        requestId: 'shake-request',
        response: { type: 'agent-shake-result', result },
      });
    } finally {
      timers.restore();
      control?.stop();
      rmSync(testDir, { recursive: true, force: true });
      for (const key of envKeys) {
        const value = savedEnv[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
