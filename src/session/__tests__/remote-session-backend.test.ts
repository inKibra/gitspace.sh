import { describe, expect, it, jest } from 'bun:test';
import type { Identity } from '../../types/identity';
import type { BackendEvent } from '../events';
import {
  RemoteSessionBackend,
  type RemoteSessionCryptoAdapter,
  type RemoteSessionHandshakeAdapter,
  type RemoteSessionSocketAdapter,
  type RemoteSessionSocketHandlers,
} from '../backends/remote-session-backend';
import { buildRemoteBackendKey } from '../backend-key';
import { PortConflictError } from '../../lib/processes/port-conflicts.js';

interface FakeSocket {
  readyState: number;
  handlers: RemoteSessionSocketHandlers | null;
  sent: string[];
  onSend?: (data: string) => void;
}

interface FakeHandshakeState {
  phase: 'hello' | 'auth';
}

interface FakeServerHello {
  hello: true;
}

interface FakeServerAuth {
  auth: true;
}

const OPEN = 1;

function createFakeSocket(): FakeSocket {
  return {
    readyState: OPEN,
    handlers: null,
    sent: [],
  };
}

const socketAdapter: RemoteSessionSocketAdapter<FakeSocket> = {
  setHandlers: (socket, handlers) => {
    socket.handlers = handlers;
  },
  clearHandlers: (socket) => {
    socket.handlers = null;
  },
  send: (socket, data) => {
    socket.sent.push(data);
    socket.onSend?.(data);
  },
  close: () => {},
  getReadyState: (socket) => socket.readyState,
  getOpenReadyStateValue: () => OPEN,
};

const cryptoAdapter: RemoteSessionCryptoAdapter = {
  masterStreamId: 0,
  controlStreamId: 1,
  async createFrame(_streamId, data) {
    return data;
  },
  async openFrame(frame) {
    return {
      streamId: 0,
      data: frame,
    };
  },
  encodeBase64(data) {
    return Buffer.from(data).toString('base64');
  },
  decodeBase64(base64) {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  },
};

const handshakeAdapter: RemoteSessionHandshakeAdapter<
  FakeHandshakeState,
  FakeServerHello,
  FakeServerAuth
> = {
  createClientHello: () => ({
    state: { phase: 'hello' },
    message: { hello: 'client' },
  }),
  isServerHello: (data): data is FakeServerHello => {
    return !!data && typeof data === 'object' && (data as { hello?: unknown }).hello === true;
  },
  processServerHello: () => ({ phase: 'auth' }),
  createClientAuth: () => ({
    state: { phase: 'auth' },
    message: { auth: 'client' },
    sessionKeys: {
      sendKey: new Uint8Array([1]),
      receiveKey: new Uint8Array([2]),
      sessionId: 'session-test',
    },
  }),
  isServerAuth: (data): data is FakeServerAuth => {
    return !!data && typeof data === 'object' && (data as { auth?: unknown }).auth === true;
  },
  processServerAuth: () => ({
    peerIdentityId: 'peer-test',
  }),
};

const identity: Identity = {
  id: 'client-1',
  signing: {
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(64),
  },
  keyExchange: {
    publicKey: new Uint8Array(32),
    privateKey: new Uint8Array(32),
  },
  createdAt: 1,
};

function makeRelayDataPayload(codec: RemoteSessionCryptoAdapter, payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return JSON.stringify({
    type: 'data',
    data: codec.encodeBase64(bytes),
  });
}

function makeRelayBinaryPayload(codec: RemoteSessionCryptoAdapter, payload: Uint8Array): string {
  return JSON.stringify({
    type: 'data',
    data: codec.encodeBase64(payload),
  });
}

function decodeRelayDataCommand(codec: RemoteSessionCryptoAdapter, raw: string): unknown {
  const relay = JSON.parse(raw) as { type: string; data?: string };
  if (relay.type !== 'data' || !relay.data) {
    return null;
  }
  const decoded = codec.decodeBase64(relay.data);
  return JSON.parse(new TextDecoder().decode(decoded));
}

interface ShakeAgentSessionRequest {
  type: 'shake_agent_session';
  requestId: string;
  target: unknown;
  agentSessionId: string;
  mode: 'elide' | 'images';
}

function isShakeAgentSessionRequest(value: unknown): value is ShakeAgentSessionRequest {
  return value !== null
    && typeof value === 'object'
    && 'type' in value
    && value.type === 'shake_agent_session'
    && 'requestId' in value
    && typeof value.requestId === 'string'
    && 'target' in value
    && 'agentSessionId' in value
    && typeof value.agentSessionId === 'string'
    && 'mode' in value
    && (value.mode === 'elide' || value.mode === 'images');
}

function makeOperationRecord(
  requestId: string,
  overrides: Partial<{
    kind: string;
    workspaceId: string;
    workspaceName: string;
    projectName: string;
    state: 'running' | 'succeeded' | 'failed' | 'cancelled';
    message: string;
    result: unknown;
    error: { code?: string; message: string };
  }> = {},
) {
  const now = Date.now();
  const workspaceId = overrides.workspaceId ?? 'alpha:ws-1';
  return {
    operationId: requestId,
    kind: overrides.kind ?? 'workspace.delete',
    scope: {
      projectName: overrides.projectName ?? 'alpha',
      workspaceId,
      workspaceName: overrides.workspaceName ?? workspaceId.split(':').slice(-1)[0],
    },
    state: overrides.state ?? 'running',
    startedAt: now,
    updatedAt: now,
    message: overrides.message,
    result: overrides.result,
    error: overrides.error,
  };
}

function sendOperationAccepted(socket: FakeSocket, requestId: string, overrides: Parameters<typeof makeOperationRecord>[1] = {}): void {
  socket.handlers?.onMessage(
    makeRelayDataPayload(cryptoAdapter, {
      type: 'operation_accepted',
      requestId,
      operation: makeOperationRecord(requestId, overrides),
    }),
  );
}

function sendOperationEvent(socket: FakeSocket, requestId: string, overrides: Parameters<typeof makeOperationRecord>[1]): void {
  const operation = makeOperationRecord(requestId, overrides);
  socket.handlers?.onMessage(
    makeRelayDataPayload(cryptoAdapter, {
      type: 'operation_event',
      event: {
        type: operation.state === 'succeeded' ? 'operation_succeeded' : 'operation_failed',
        operation,
      },
    }),
  );
}

function sendOperationSnapshot(socket: FakeSocket, operations: ReturnType<typeof makeOperationRecord>[]): void {
  socket.handlers?.onMessage(
    makeRelayDataPayload(cryptoAdapter, {
      type: 'operation_snapshot',
      operations,
    }),
  );
}

function sendOperationDismissed(socket: FakeSocket, operationId: string): void {
  socket.handlers?.onMessage(
    makeRelayDataPayload(cryptoAdapter, {
      type: 'operation_dismissed',
      operationId,
    }),
  );
}


function createEmptyMachineSnapshot() {
  return {
    snapshotNonce: 1,
    generatedAt: new Date().toISOString(),
    projectsById: {},
    projectOrder: [],
    workspacesById: {},
    workspaceOrder: [],
    workspaceIdsByProjectId: {},
    terminalSessionsById: {},
    terminalSessionIdsByWorkspaceId: {},
    agentSessionsById: {},
    agentSessionIdsByWorkspaceId: {},
    processesById: {},
    processIdsByWorkspaceId: {},
    replaysById: {},
    replayIdsByWorkspaceId: {},
    notificationsById: {},
    notificationOrder: [],
  };
}

function createMachineSnapshotWithWorkspace() {
  return {
    ...createEmptyMachineSnapshot(),
    projectsById: {
      alpha: {
        id: 'alpha',
        name: 'alpha',
        repository: 'org/alpha',
        isCurrent: true,
        workspaceIds: ['alpha:ws-1'],
        workspaceCount: 1,
      },
    },
    projectOrder: ['alpha'],
    workspacesById: {
      'alpha:ws-1': {
        id: 'alpha:ws-1',
        name: 'ws-1',
        projectId: 'alpha',
        projectName: 'alpha',
        path: '/tmp/alpha/ws-1',
        terminalSessionIds: [],
        agentSessionIds: [],
        processIds: [],
        replayIds: [],
        summary: {
          terminalCount: 0,
          attachedTerminalCount: 0,
          runningTerminalCount: 0,
          failedTerminalCount: 0,
          agentCount: 0,
          runningAgentCount: 0,
          waitingAgentCount: 0,
          permissionAgentCount: 0,
          retryingAgentCount: 0,
          closedAgentCount: 0,
          archivedAgentCount: 0,
          configuredProcessCount: 0,
          runningProcessCount: 0,
          failedProcessCount: 0,
        },
      },
    },
    workspaceOrder: ['alpha:ws-1'],
    workspaceIdsByProjectId: { alpha: ['alpha:ws-1'] },
  };
}

async function connectAndHandshake(
  backend: RemoteSessionBackend<FakeSocket, FakeHandshakeState, FakeServerHello, FakeServerAuth>,
  socket: FakeSocket
): Promise<void> {
  const connectPromise = backend.connect();
  socket.handlers?.onMessage(JSON.stringify({ type: 'connection_established' }));
  await Bun.sleep(0);
  socket.handlers?.onMessage(
    makeRelayDataPayload(cryptoAdapter, {
      type: 'handshake',
      phase: 'server_hello',
      data: { hello: true },
    })
  );
  await Bun.sleep(0);
  socket.handlers?.onMessage(
    makeRelayDataPayload(cryptoAdapter, {
      type: 'handshake',
      phase: 'server_auth',
      data: { auth: true },
    })
  );
  for (let i = 0; i < 5; i += 1) {
    await Bun.sleep(0);
    if (((backend as unknown) as { isConnected?: boolean }).isConnected) {
      break;
    }
  }
  socket.handlers?.onMessage(
    makeRelayDataPayload(cryptoAdapter, {
      type: 'machine_snapshot',
      snapshot: createEmptyMachineSnapshot(),
    })
  );
  await Bun.sleep(0);
  await connectPromise;
}

async function connectAndHandshakeWithoutSnapshot(
  backend: RemoteSessionBackend<FakeSocket, FakeHandshakeState, FakeServerHello, FakeServerAuth>,
  socket: FakeSocket
): Promise<void> {
  const connectPromise = backend.connect();
  socket.handlers?.onMessage(JSON.stringify({ type: 'connection_established' }));
  await Bun.sleep(0);
  socket.handlers?.onMessage(
    makeRelayDataPayload(cryptoAdapter, {
      type: 'handshake',
      phase: 'server_hello',
      data: { hello: true },
    })
  );
  await Bun.sleep(0);
  socket.handlers?.onMessage(
    makeRelayDataPayload(cryptoAdapter, {
      type: 'handshake',
      phase: 'server_auth',
      data: { auth: true },
    })
  );
  await connectPromise;
}

function createBackend(socket: FakeSocket): RemoteSessionBackend<FakeSocket, FakeHandshakeState, FakeServerHello, FakeServerAuth> {
  return new RemoteSessionBackend({
    descriptor: {
      key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
      kind: 'remote',
      label: 'Machine 1',
      relayUrl: 'wss://relay.test/ws',
      machineId: 'machine-1',
    },
    socket,
    socketAdapter,
    identity,
    machineId: 'machine-1',
    deviceCertificate: 'test-device-cert',
    signer: (message) => ({ ...message, signature: { sig: 'x' } }),
    crypto: cryptoAdapter,
    handshake: handshakeAdapter,
  });
}

describe('RemoteSessionBackend', () => {
  it('propagates graceful terminate options through the typed command path', async () => {
    const socket = createFakeSocket();
    const backend = createBackend(socket);
    await connectAndHandshake(backend, socket);

    const terminatePromise = backend.terminateSession('session-1', { mode: 'graceful', graceMs: 8000 });
    await Bun.sleep(0);
    const request = decodeRelayDataCommand(cryptoAdapter, socket.sent.at(-1) ?? '');
    expect(request).toMatchObject({
      type: 'terminate_session',
      sessionId: 'session-1',
      mode: 'graceful',
      graceMs: 8000,
    });

    const requestId = (request as { requestId: string }).requestId;
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, { type: 'command_response', requestId, response: { type: 'ok' } }));
    await expect(terminatePromise).resolves.toBeUndefined();
  });

  it('connects, performs handshake, and emits machine events', async () => {
    const socket = createFakeSocket();
    const events: BackendEvent[] = [];
    const ptyChunks: string[] = [];

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    backend.onEvent((event) => events.push(event));
    backend.setPtyOutputHandler((data) => {
      ptyChunks.push(new TextDecoder().decode(data));
    });

    const connectPromise = backend.connect();

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]).type).toBe('connect_to_machine');

    socket.handlers?.onMessage(JSON.stringify({ type: 'connection_established' }));
    expect(JSON.parse(socket.sent[1])).toEqual({
      type: 'handshake',
      phase: 'client_hello',
      data: { hello: 'client' },
    });

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'handshake',
        phase: 'server_hello',
        data: { hello: true },
      })
    );

    expect(JSON.parse(socket.sent[2])).toEqual({
      type: 'handshake',
      phase: 'client_auth',
      data: { auth: 'client' },
    });

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'handshake',
        phase: 'server_auth',
        data: { auth: true },
      })
    );

    await connectPromise;

    expect(events[0]).toEqual({ type: 'status', status: 'connecting' });
    expect(events[1]).toEqual({ type: 'status', status: 'connected' });

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'machine_snapshot',
        snapshot: {
          snapshotNonce: 1,
          generatedAt: new Date().toISOString(),
          projectsById: { alpha: { id: 'alpha', name: 'alpha', path: '/tmp/alpha', repository: 'org/alpha', workspaceIds: ['alpha:ws-1'], workspaceCount: 1, activeWorkspaceId: 'alpha:ws-1', current: true } },
          projectOrder: ['alpha'],
          workspacesById: {},
          workspaceOrder: [],
          workspaceIdsByProjectId: { alpha: [] },
          terminalSessionsById: {},
          terminalSessionIdsByWorkspaceId: {},
          agentSessionsById: {},
          agentSessionIdsByWorkspaceId: {},
          processesById: {},
          processIdsByWorkspaceId: {},
          replaysById: {},
          replayIdsByWorkspaceId: {},
          notificationsById: {},
          notificationOrder: [],
        },
      })
    );
    await Bun.sleep(0);

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'script_output',
        phase: 'setup',
        data: cryptoAdapter.encodeBase64(new TextEncoder().encode('setup output')),
      })
    );
    await Bun.sleep(0);

    expect(events.some((event) => event.type === 'projects' && event.projects[0]?.name === 'alpha' && event.projects[0]?.repository === 'org/alpha')).toBe(true);

    expect(events).toContainEqual({
      type: 'script_output',
      phase: 'setup',
      data: new TextEncoder().encode('setup output'),
      done: undefined,
      error: undefined,
      exitCode: undefined,
      workspaceId: undefined,
    });
    // Script bytes flow through the script channel, not the PTY handler.
    expect(ptyChunks).toEqual([]);
  });

  it('times out API reads when the initial machine snapshot never arrives', async () => {
    const socket = createFakeSocket();
    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });
    await connectAndHandshakeWithoutSnapshot(backend, socket);

    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));

    jest.useFakeTimers();
    try {
      const projectsPromise = backend.listProjects();
      await Promise.resolve();
      jest.advanceTimersByTime(15_001);
      await expect(projectsPromise).rejects.toThrow('Timed out waiting for initial machine snapshot from machine-1');
    } finally {
      jest.useRealTimers();
    }

    // The timeout must surface as backend state (snapshot_error) so the board
    // renders an error + retry instead of an infinite loading spinner.
    expect(events).toContainEqual({
      type: 'snapshot_error',
      message: 'Timed out waiting for initial machine snapshot from machine-1',
    });
  });

  it('accepts workspace-phase-preview responses from the remote machine', async () => {
    const socket = createFakeSocket();
    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });
    await connectAndHandshake(backend, socket);
    const previewPromise = backend.previewWorkspaceStatusChange('alpha', 'ws-1', 'review');
    await Bun.sleep(0);
    const command = decodeRelayDataCommand(cryptoAdapter, socket.sent.at(-1) ?? '') as { requestId: string; type: string };
    expect(command.type).toBe('preview_workspace_phase');
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'command_response',
      requestId: command.requestId,
      response: {
        type: 'workspace-phase-preview',
        preview: {
          allowed: true,
          requiresCascade: false,
          requestedPhase: 'review',
          affected: [],
          message: 'ok',
        },
      },
    }));
    await expect(previewPromise).resolves.toMatchObject({ allowed: true, requestedPhase: 'review' });
  });

  it('extracts JSON payloads even when artifact content mentions exit code', () => {
    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket: createFakeSocket(),
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });
    const output = `Artifact saved\n{"body":"saw exit code: 7 in stderr","ok":true}`;
    expect(((backend as unknown) as { unwrapSpaceCommandOutput(output: string): string }).unwrapSpaceCommandOutput(output)).toBe('{"body":"saw exit code: 7 in stderr","ok":true}');
  });

  it('projects pushed agent state snapshots into machine snapshot events', async () => {
    const socket = createFakeSocket();
    const events: BackendEvent[] = [];
    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });
    backend.onEvent((event) => events.push(event));

    await connectAndHandshake(backend, socket);
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'machine_snapshot',
        snapshot: {
          ...createEmptyMachineSnapshot(),
          projectsById: {
            alpha: {
              id: 'alpha',
              name: 'alpha',
              repository: 'org/alpha',
              isCurrent: true,
              workspaceIds: ['alpha:ws-1'],
              workspaceCount: 1,
            },
          },
          projectOrder: ['alpha'],
          workspacesById: {
            'alpha:ws-1': {
              id: 'alpha:ws-1',
              name: 'ws-1',
              projectId: 'alpha',
              projectName: 'alpha',
              path: '/tmp/alpha/ws-1',
              terminalSessionIds: [],
              agentSessionIds: [],
              processIds: [],
              replayIds: [],
              summary: {
                terminalCount: 0,
                attachedTerminalCount: 0,
                runningTerminalCount: 0,
                failedTerminalCount: 0,
                agentCount: 0,
                runningAgentCount: 0,
                waitingAgentCount: 0,
                permissionAgentCount: 0,
                retryingAgentCount: 0,
                closedAgentCount: 0,
                archivedAgentCount: 0,
                configuredProcessCount: 0,
                runningProcessCount: 0,
                failedProcessCount: 0,
              },
            },
          },
          workspaceOrder: ['alpha:ws-1'],
          workspaceIdsByProjectId: { alpha: ['alpha:ws-1'] },
        },
      })
    );
    await Bun.sleep(0);

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'agent_state_snapshot',
        workspaces: [{
          workspaceId: 'alpha:ws-1',
          sessions: [{ id: 'agent-1', title: 'Agent 1' }],
          statuses: { 'agent-1': { type: 'idle' } },
          pendingPermissions: {},
          pendingQuestions: {},
          lastMessages: {},
          errorMessages: {},
          todoPhases: {},
          modelInfo: {},
          queuedMessages: {},
        }],
      })
    );
    await Bun.sleep(0);

    const machineEvents = events.filter(
      (event): event is Extract<BackendEvent, { type: 'machine_snapshot' }> => event.type === 'machine_snapshot',
    );
    const latestSnapshot = machineEvents.at(-1)?.snapshot;
    expect(latestSnapshot?.agentSessionsById['agent-1']?.state).toBe('waiting');
    expect(latestSnapshot?.agentSessionIdsByWorkspaceId['alpha:ws-1']).toContain('agent-1');
  });

  it('projects agent status and permission deltas into derived machine state', async () => {
    const socket = createFakeSocket();
    const events: BackendEvent[] = [];
    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });
    backend.onEvent((event) => events.push(event));

    await connectAndHandshake(backend, socket);
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'machine_snapshot',
      snapshot: createMachineSnapshotWithWorkspace(),
    }));
    await Bun.sleep(0);
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'agent_state_snapshot',
      workspaces: [{
        workspaceId: 'alpha:ws-1',
        sessions: [{ id: 'agent-1', title: 'Agent One' }],
        statuses: {},
        pendingPermissions: {},
        pendingQuestions: {},
        lastMessages: {},
        errorMessages: {},
        todoPhases: {},
        modelInfo: {},
        queuedMessages: {},
      }],
    }));
    await Bun.sleep(0);

    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'agent_state_update',
      delta: { type: 'agent_session_status', workspaceId: 'alpha:ws-1', sessionId: 'agent-1', status: { type: 'busy' } },
    }));
    await Bun.sleep(0);
    let latestSnapshot = events.filter((event): event is Extract<BackendEvent, { type: 'machine_snapshot' }> => event.type === 'machine_snapshot').at(-1)?.snapshot;
    expect(latestSnapshot?.agentSessionsById['agent-1']?.state).toBe('running');
    expect(latestSnapshot?.workspacesById['alpha:ws-1']?.summary.runningAgentCount).toBe(1);

    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'agent_state_update',
      delta: {
        type: 'agent_permission_added',
        workspaceId: 'alpha:ws-1',
        sessionId: 'agent-1',
        permission: { id: 'perm-1', type: 'permission', prompt: 'Allow command?', command: 'ls' },
      },
    }));
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'agent_state_update',
      delta: {
        type: 'agent_question_added',
        workspaceId: 'alpha:ws-1',
        sessionId: 'agent-1',
        question: { id: 'question-1', sessionId: 'agent-1', prompt: 'Continue?', options: [] },
      },
    }));
    await Bun.sleep(0);

    latestSnapshot = events.filter((event): event is Extract<BackendEvent, { type: 'machine_snapshot' }> => event.type === 'machine_snapshot').at(-1)?.snapshot;
    expect(latestSnapshot?.agentSessionsById['agent-1']?.state).toBe('permission-needed');
    expect(latestSnapshot?.agentSessionsById['agent-1']?.pendingPermissionCount).toBe(1);
    expect(latestSnapshot?.agentSessionsById['agent-1']?.pendingQuestionCount).toBe(1);
    expect(latestSnapshot?.workspacesById['alpha:ws-1']?.summary.permissionAgentCount).toBe(1);
  });

  it('does not resurrect an optimistically closed agent from a stale machine snapshot', async () => {
    const socket = createFakeSocket();
    const events: BackendEvent[] = [];
    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });
    backend.onEvent((event) => events.push(event));

    await connectAndHandshake(backend, socket);
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'machine_snapshot',
      snapshot: createMachineSnapshotWithWorkspace(),
    }));
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'agent_state_snapshot',
      workspaces: [{
        workspaceId: 'alpha:ws-1',
        sessions: [{ id: 'agent-1', title: 'Agent One' }],
        statuses: { 'agent-1': { type: 'busy' } },
        pendingPermissions: {},
        pendingQuestions: {},
        lastMessages: {},
        errorMessages: {},
        todoPhases: {},
        modelInfo: {},
        queuedMessages: {},
      }],
    }));
    await Bun.sleep(0);

    const closePromise = backend.closeAgentSession('alpha:ws-1', 'agent-1');
    await Bun.sleep(0);
    const closeCommand = decodeRelayDataCommand(cryptoAdapter, socket.sent.at(-1) ?? '') as { requestId: string };
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'command_response',
      requestId: closeCommand.requestId,
      response: {
        type: 'agent-sessions',
        sessions: [{ id: 'agent-1', title: 'Agent One', closedAt: new Date().toISOString() }],
      },
    }));
    await closePromise;
    await Bun.sleep(0);

    const staleSnapshot = createMachineSnapshotWithWorkspace() as any;
    staleSnapshot.agentSessionsById['agent-1'] = {
      id: 'agent-1',
      workspaceId: 'alpha:ws-1',
      projectId: 'alpha',
      title: 'Agent One',
      state: 'running',
      pendingPermissionIds: [],
      pendingPermissionCount: 0,
      pendingQuestionIds: [],
      pendingQuestionCount: 0,
    };
    staleSnapshot.agentSessionIdsByWorkspaceId['alpha:ws-1'] = ['agent-1'];
    staleSnapshot.workspacesById['alpha:ws-1']!.agentSessionIds = ['agent-1'];
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'machine_snapshot',
      snapshot: staleSnapshot,
    }));
    await Bun.sleep(0);

    const latestSnapshot = events.filter((event): event is Extract<BackendEvent, { type: 'machine_snapshot' }> => event.type === 'machine_snapshot').at(-1)?.snapshot;
    expect(latestSnapshot?.agentSessionsById['agent-1']?.state).toBe('closed');
    expect(latestSnapshot?.workspacesById['alpha:ws-1']?.summary.closedAgentCount).toBe(1);
  });



  it('applies agent state deltas to the local machine snapshot cache', async () => {
    const socket = createFakeSocket();
    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'agent_state_snapshot',
      workspaces: [{
        workspaceId: 'alpha:ws-1',
        sessions: [{ id: 'agent-1', title: 'Agent One' }],
        statuses: {},
        pendingPermissions: {},
        pendingQuestions: {},
        lastMessages: {},
        errorMessages: {},
        todoPhases: {},
        modelInfo: {},
        queuedMessages: {},
      }],
    }));
    await Bun.sleep(0);

    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'agent_state_update',
      delta: {
        type: 'agent_todo_update',
        workspaceId: 'alpha:ws-1',
        sessionId: 'agent-1',
        phases: [{ name: 'Phase', tasks: [{ content: 'Fix the bug', status: 'in_progress' }] }],
      },
    }));
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'agent_state_update',
      delta: {
        type: 'agent_session_error',
        workspaceId: 'alpha:ws-1',
        sessionId: 'agent-1',
        errorMessage: 'boom',
      },
    }));
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'agent_state_update',
      delta: {
        type: 'agent_question_added',
        workspaceId: 'alpha:ws-1',
        sessionId: 'agent-1',
        question: { id: 'q1', sessionId: 'agent-1', prompt: 'Continue?', options: [] },
      },
    }));
    await Bun.sleep(0);

    const state = backend.getAgentStateSnapshot()['alpha:ws-1']!;
    expect(state.todoPhases['agent-1']?.[0]?.tasks[0]?.content).toBe('Fix the bug');
    expect(state.errorMessages['agent-1']).toBe('boom');
    expect(state.pendingQuestions['agent-1']?.[0]?.id).toBe('q1');

    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'agent_state_update',
      delta: {
        type: 'agent_question_removed',
        workspaceId: 'alpha:ws-1',
        sessionId: 'agent-1',
        requestId: 'q1',
      },
    }));
    await Bun.sleep(0);

    expect(backend.getAgentStateSnapshot()['alpha:ws-1']!.pendingQuestions['agent-1']).toBeUndefined();
  });

  it('resolves agent session list responses from machine messages', async () => {
    const socket = createFakeSocket();
    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'machine_snapshot',
        snapshot: {
          snapshotNonce: 1,
          generatedAt: new Date().toISOString(),
          projectsById: { project: { id: 'project', name: 'project', path: '/tmp/project', repository: 'org/project', workspaceIds: ['project:workspace'], workspaceCount: 1 } },
          projectOrder: ['project'],
          workspacesById: { 'project:workspace': { id: 'project:workspace', name: 'workspace', path: '/tmp/project/workspaces/workspace', projectName: 'project', branch: 'workspace', summary: { terminalCount: 0, managedProcessCount: 0, runningProcessCount: 0, idleAgentCount: 0, activeAgentCount: 0 }, updatedAt: new Date().toISOString() } },
          workspaceOrder: ['project:workspace'],
          workspaceIdsByProjectId: { project: ['project:workspace'] },
          terminalSessionsById: {},
          terminalSessionIdsByWorkspaceId: {},
          agentSessionsById: {},
          agentSessionIdsByWorkspaceId: {},
          processesById: {},
          processIdsByWorkspaceId: {},
          replaysById: {},
          replayIdsByWorkspaceId: {},
          notificationsById: {},
          notificationOrder: [],
        },
      }),
    );
    await Bun.sleep(0);

    const pending = backend.listAgentSessions('project:workspace');
    await Bun.sleep(0);
    const sent = decodeRelayDataCommand(cryptoAdapter, socket.sent.at(-1) ?? '') as { requestId: string; type: string };
    expect(sent.type).toBe('list_agent_sessions');

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'command_response',
        requestId: sent.requestId,
        response: {
          type: 'agent-sessions',
          sessions: [
            { id: 'agent-1', title: 'Investigate auth', updatedAt: '2026-03-15T12:00:00.000Z' },
          ],
        },
      }),
    );

    await expect(pending).resolves.toEqual([
      { id: 'agent-1', title: 'Investigate auth', updatedAt: '2026-03-15T12:00:00.000Z' },
    ]);
  });

  it('buffers PTY output while no callback is registered and flushes on restore', async () => {
    const socket = createFakeSocket();
    const output: string[] = [];

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    const connectPromise = backend.connect();

    socket.handlers?.onMessage(JSON.stringify({ type: 'connection_established' }));
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'handshake',
        phase: 'server_hello',
        data: { hello: true },
      })
    );
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'handshake',
        phase: 'server_auth',
        data: { auth: true },
      })
    );
    await connectPromise;

    await backend.attachSession({ sessionId: 'sess-1', workspaceId: 'alpha:ws-1' });

    socket.handlers?.onMessage(
      makeRelayBinaryPayload(cryptoAdapter, new TextEncoder().encode('snapshot-before-handler'))
    );
    await Bun.sleep(0);

    backend.setPtyOutputHandler((data) => {
      output.push(new TextDecoder().decode(data));
    });

    socket.handlers?.onMessage(
      makeRelayBinaryPayload(cryptoAdapter, new TextEncoder().encode('live-after-handler'))
    );
    await Bun.sleep(0);

    expect(output).toEqual(['snapshot-before-handler', 'live-after-handler']);
  });

it('does not emit attached until the real attach event arrives and preserves pre-attached PTY output', async () => {
  const socket = createFakeSocket();
  const events: BackendEvent[] = [];
  const output: string[] = [];

  const backend = new RemoteSessionBackend({
    descriptor: {
      key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
      kind: 'remote',
      label: 'Machine 1',
      relayUrl: 'wss://relay.test/ws',
      machineId: 'machine-1',
    },
    socket,
    socketAdapter,
    identity,
    machineId: 'machine-1',
    deviceCertificate: 'test-device-cert',
    signer: (message) => ({ ...message, signature: { sig: 'x' } }),
    crypto: cryptoAdapter,
    handshake: handshakeAdapter,
  });

  backend.onEvent((event) => events.push(event));
  backend.setPtyOutputHandler((data) => {
    output.push(new TextDecoder().decode(data));
  });

  await connectAndHandshake(backend, socket);
  await backend.attachSession({ sessionId: 'sess-1', workspaceId: 'alpha:ws-1' });

  socket.handlers?.onMessage(
    makeRelayBinaryPayload(cryptoAdapter, new TextEncoder().encode('snapshot-before-attached'))
  );
  await Bun.sleep(0);

  expect(output).toEqual(['snapshot-before-attached']);
  expect(events.some((event) => event.type === 'attached')).toBe(false);

  socket.handlers?.onMessage(
    makeRelayDataPayload(cryptoAdapter, {
      type: 'attached',
      streamId: 2,
      sessionId: 'sess-1',
      sessionName: 'alpha:ws-1:1',
    })
  );
  await Bun.sleep(0);

  expect(events).toContainEqual(expect.objectContaining({
    type: 'attached',
    sessionId: 'sess-1',
    sessionName: 'alpha:ws-1:1',
    workspaceId: 'alpha:ws-1',
  }));
});


  it('lists replays and emits replay events', async () => {
    const socket = createFakeSocket();
    const events: BackendEvent[] = [];

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    backend.onEvent((event) => events.push(event));
    await connectAndHandshake(backend, socket);

    await backend.listReplays('alpha:ws-1', true);
    const command = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]);
    expect(command).toEqual({ type: 'list_replays', workspaceId: 'alpha:ws-1', includeDismissed: true });

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'replay_list',
        replays: [
          {
            replayId: 'replay-1',
            sessionId: 'sess-1',
            sessionName: 'ghost',
            cwd: '/tmp/ws-1',
            workspaceId: 'alpha:ws-1',
            projectName: 'alpha',
            workspaceName: 'ws-1',
            startedAt: 1,
            endedAt: 2,
            status: 'closed',
            durationMs: 1,
            eventCount: 1,
            checkpointCount: 1,
            lastSeq: 1,
          },
        ],
      })
    );
    await Bun.sleep(0);

    expect(events).toContainEqual({
      type: 'replays',
      replays: [expect.objectContaining({ replayId: 'replay-1', workspaceId: 'alpha:ws-1' })],
    });
  });

  it('round-trips replay ansi and replay dismissal commands', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const mockFrame = {
      replayId: 'replay-1',
      checkpoint: null,
      events: [{ seq: 2, t: 50, type: 'output' as const, data: 'dGVzdA==' }],
    };
    const framePromise = backend.getReplayFrame('replay-1', { atMs: 50, atSeq: 2 });
    await Bun.sleep(0);
    const sentCommand = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]) as Record<string, unknown>;
    expect(sentCommand).toEqual({
      type: 'get_replay_frame',
      replayId: 'replay-1',
      requestId: expect.any(String),
      atMs: 50,
      atSeq: 2,
    });
    const requestId = sentCommand.requestId as string;
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'replay_frame',
        replayId: 'replay-1',
        requestId,
        frame: mockFrame,
      })
    );
    await expect(framePromise).resolves.toEqual(mockFrame);

    const dismissPromise = backend.dismissReplay('replay-1');
    await Bun.sleep(0);
    expect(decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1])).toEqual({
      type: 'dismiss_replay',
      replayId: 'replay-1',
    });
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, { type: 'replay_dismissed', replayId: 'replay-1' }));
    await expect(dismissPromise).resolves.toBeUndefined();

    const undismissPromise = backend.undismissReplay('replay-1');
    await Bun.sleep(0);
    expect(decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1])).toEqual({
      type: 'undismiss_replay',
      replayId: 'replay-1',
    });
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, { type: 'replay_undismissed', replayId: 'replay-1' }));
    await expect(undismissPromise).resolves.toBeUndefined();

    const timelinePromise = backend.getReplayTimeline('replay-1');
    await Bun.sleep(0);
    expect(decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1])).toEqual({
      type: 'get_replay_timeline',
      replayId: 'replay-1',
    });
    socket.handlers?.onMessage(makeRelayDataPayload(cryptoAdapter, {
      type: 'replay_timeline',
      replayId: 'replay-1',
      timeline: {
        replayId: 'replay-1',
        durationMs: 50,
        latestTimeMs: 50,
        steps: [{ timeMs: 0, seq: 0 }, { timeMs: 50, seq: 2 }],
        checkpointSteps: [{ timeMs: 0, seq: 0 }],
      },
    }));
    await expect(timelinePromise).resolves.toEqual({
      replayId: 'replay-1',
      durationMs: 50,
      latestTimeMs: 50,
      steps: [{ timeMs: 0, seq: 0 }, { timeMs: 50, seq: 2 }],
      checkpointSteps: [{ timeMs: 0, seq: 0 }],
    });
  });

  it('preserves script phase banner and output ordering during running scripts', async () => {
    const socket = createFakeSocket();
    const events: BackendEvent[] = [];
    const ptyChunks: string[] = [];
    const scriptChunks: string[] = [];

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    backend.onEvent((event) => events.push(event));
    backend.setPtyOutputHandler((data) => {
      ptyChunks.push(new TextDecoder().decode(data));
    });
    backend.setScriptOutputHandler((data) => {
      scriptChunks.push(new TextDecoder().decode(data));
    });

    await connectAndHandshake(backend, socket);

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'script_output',
        phase: 'pre',
        data: cryptoAdapter.encodeBase64(new TextEncoder().encode('==> pre scripts...\n')),
      })
    );

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'script_output',
        phase: 'setup',
        data: cryptoAdapter.encodeBase64(new TextEncoder().encode('==> setup scripts...\n')),
      })
    );

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'script_output',
        phase: 'setup',
        data: cryptoAdapter.encodeBase64(new TextEncoder().encode('installing deps\n')),
      })
    );

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'script_output',
        phase: 'select',
        data: cryptoAdapter.encodeBase64(new TextEncoder().encode('==> select scripts...\n')),
      })
    );

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'script_output',
        phase: 'select',
        data: cryptoAdapter.encodeBase64(new TextEncoder().encode('opening shell\n')),
      })
    );
    await Bun.sleep(0);

    // Script bytes flow through the dedicated script channel, not the PTY handler.
    expect(ptyChunks).toEqual([]);
    expect(scriptChunks).toEqual([
      '==> pre scripts...\n',
      '==> setup scripts...\n',
      'installing deps\n',
      '==> select scripts...\n',
      'opening shell\n',
    ]);

    const scriptEvents = events.filter(
      (event): event is Extract<BackendEvent, { type: 'script_output' }> => event.type === 'script_output'
    );
    const chunks = scriptEvents.map((event) => ({
      phase: event.phase,
      text: new TextDecoder().decode(event.data),
    }));

    expect(chunks).toEqual([
      { phase: 'pre', text: '==> pre scripts...\n' },
      { phase: 'setup', text: '==> setup scripts...\n' },
      { phase: 'setup', text: 'installing deps\n' },
      { phase: 'select', text: '==> select scripts...\n' },
      { phase: 'select', text: 'opening shell\n' },
    ]);
  });

  it('re-buffers PTY output after callback is cleared and flushes on re-register', async () => {
    const socket = createFakeSocket();
    const callbackOneOutput: string[] = [];
    const callbackTwoOutput: string[] = [];

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    const connectPromise = backend.connect();

    socket.handlers?.onMessage(JSON.stringify({ type: 'connection_established' }));
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'handshake',
        phase: 'server_hello',
        data: { hello: true },
      })
    );
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'handshake',
        phase: 'server_auth',
        data: { auth: true },
      })
    );
    await connectPromise;

    backend.setPtyOutputHandler((data) => {
      callbackOneOutput.push(new TextDecoder().decode(data));
    });

    await backend.attachSession({ sessionId: 'sess-1', workspaceId: 'alpha:ws-1' });

    socket.handlers?.onMessage(
      makeRelayBinaryPayload(cryptoAdapter, new TextEncoder().encode('before-clear'))
    );
    await Bun.sleep(0);

    backend.setPtyOutputHandler(null);

    socket.handlers?.onMessage(
      makeRelayBinaryPayload(cryptoAdapter, new TextEncoder().encode('while-cleared'))
    );
    await Bun.sleep(0);

    backend.setPtyOutputHandler((data) => {
      callbackTwoOutput.push(new TextDecoder().decode(data));
    });

    socket.handlers?.onMessage(
      makeRelayBinaryPayload(cryptoAdapter, new TextEncoder().encode('after-restore'))
    );
    await Bun.sleep(0);

    expect(callbackOneOutput).toEqual(['before-clear']);
    expect(callbackTwoOutput).toEqual(['before-clearwhile-cleared', 'after-restore']);
  });

  it('emits workspace-scoped saved filters from tmux events response', async () => {
    const socket = createFakeSocket();
    const events: BackendEvent[] = [];

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    backend.onEvent((event) => events.push(event));
    await connectAndHandshake(backend, socket);

    const savedFilters = [{ name: 'Errors', filter: { level: 'error' as const }, sinceMinutes: 30 }];

    const sentBefore = socket.sent.length;
    const requestPromise = backend.requestEvents('/tmp/alpha/workspaces/ws-2');
    await Bun.sleep(0);
    const command = decodeRelayDataCommand(cryptoAdapter, socket.sent[sentBefore]);
    expect(command).toMatchObject({ type: 'request_events' });
    const requestId = (command as { requestId: string }).requestId;
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'command_response',
        requestId,
        response: { type: 'events-list', workspaceId: 'alpha:ws-2', events: [], liveEventIds: [], savedEventFilters: savedFilters },
      })
    );
    await requestPromise;
    await Bun.sleep(0);

    expect(events).toContainEqual({
      type: 'events',
      events: [],
      liveEventIds: [],
      savedEventFilters: savedFilters,
    });
  });

  it('emits saved filters from tmux events response', async () => {
    const socket = createFakeSocket();
    const events: BackendEvent[] = [];

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    backend.onEvent((event) => events.push(event));
    await connectAndHandshake(backend, socket);

    const savedFilters = [{ name: 'Web', filter: { processName: 'web' } }];
    const sentBefore = socket.sent.length;
    const requestPromise = backend.requestEvents('/tmp/alpha/workspaces/ws-2');
    await Bun.sleep(0);
    const command = decodeRelayDataCommand(cryptoAdapter, socket.sent[sentBefore]) as { requestId: string };
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'command_response',
        requestId: command.requestId,
        response: { type: 'events-list', workspaceId: 'alpha:ws-2', events: [], liveEventIds: [], savedEventFilters: savedFilters },
      })
    );
    await requestPromise;
    await Bun.sleep(0);

    expect(events).toContainEqual({
      type: 'events',
      events: [],
      liveEventIds: [],
      savedEventFilters: savedFilters,
    });
  });

  it('refreshes workspace and scoped session list after kill when workspace is known', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const sentBefore = socket.sent.length;
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'session_killed',
        sessionId: 'sess-1',
        workspaceId: 'alpha:ws-1',
      })
    );
    await Bun.sleep(0);

    const commands = socket.sent
      .slice(sentBefore)
      .map((raw) => decodeRelayDataCommand(cryptoAdapter, raw));

    expect(commands).toEqual([]);
  });

  it('refreshes full session list after kill when workspace is unknown', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const sentBefore = socket.sent.length;
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'session_killed',
        sessionId: 'sess-1',
        workspaceId: 'unknown',
      })
    );
    await Bun.sleep(0);

    const commands = socket.sent
      .slice(sentBefore)
      .map((raw) => decodeRelayDataCommand(cryptoAdapter, raw));

    expect(commands).toEqual([]);
  });

  it('sends scriptPolicy only for workspace attach retries', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    const connectPromise = backend.connect();

    socket.handlers?.onMessage(JSON.stringify({ type: 'connection_established' }));
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'handshake',
        phase: 'server_hello',
        data: { hello: true },
      })
    );
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'handshake',
        phase: 'server_auth',
        data: { auth: true },
      })
    );
    await connectPromise;

    await backend.attachSession({
      workspaceId: 'test-project:feature-a',
      sessionName: 'new-session',
      cols: 100,
      rows: 30,
      scriptPolicy: 'skip',
    });

    const workspaceAttach = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]);
    expect(workspaceAttach).toEqual({
      type: 'attach_session',
      streamId: 2,
      workspaceId: 'test-project:feature-a',
      sessionName: 'new-session',
      cols: 100,
      rows: 30,
      scriptPolicy: 'skip',
    });

    await backend.attachSession({ sessionId: 'existing-session' });
    const existingAttach = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]);
    expect(existingAttach).toEqual({
      type: 'attach_session',
      streamId: 2,
      sessionId: 'existing-session',
      cols: 80,
      rows: 24,
    });
  });

  it('resolves workspace id from the machine snapshot when attaching an existing session', async () => {
    const socket = createFakeSocket();
    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'machine_snapshot',
        snapshot: {
          ...createEmptyMachineSnapshot(),
          terminalSessionsById: {
            'existing-session': {
              id: 'existing-session',
              name: 'feature-a',
              workspaceId: 'test-project:feature-a',
              cwd: '/tmp/test-project/workspaces/feature-a',
              socketPath: '/tmp/existing-session.sock',
              kind: 'terminal',
              hidden: false,
              state: 'detached',
              attached: false,
              createdAt: 1,
              metadata: { workspaceId: 'test-project:feature-a' },
            },
          },
          terminalSessionIdsByWorkspaceId: {
            'test-project:feature-a': ['existing-session'],
          },
        },
      })
    );
    await Bun.sleep(0);

    await backend.attachSession({ sessionId: 'existing-session' });

    const existingAttach = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]);
    expect(existingAttach).toMatchObject({
      type: 'attach_session',
      streamId: 2,
      sessionId: 'existing-session',
      workspaceId: 'test-project:feature-a',
    });
  });

  it('waits for workspace_deleted when deleting a workspace', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const deletePromise = backend.deleteWorkspace('alpha', 'ws-1', { scriptPolicy: 'skip' });
    await Bun.sleep(0);
    const deleteCommand = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]) as { requestId?: string } | null;
    expect(deleteCommand).toMatchObject({
      type: 'delete_workspace',
      projectName: 'alpha',
      workspaceId: 'ws-1',
      scriptPolicy: 'skip',
    });
    expect(typeof deleteCommand?.requestId).toBe('string');

    sendOperationAccepted(socket, deleteCommand!.requestId!, { workspaceId: 'alpha:ws-1' });
    sendOperationEvent(socket, deleteCommand!.requestId!, {
      workspaceId: 'alpha:ws-1',
      state: 'succeeded',
      result: { type: 'workspace_deleted', requestId: deleteCommand!.requestId, workspaceId: 'alpha:ws-1' },
    });

    await expect(deletePromise).resolves.toBeUndefined();
  });

  it('rejects workspace delete when backend returns an error', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const deletePromise = backend.deleteWorkspace('alpha', 'ws-1');
    await Bun.sleep(0);
    const deleteCommand = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]) as { requestId?: string } | null;
    sendOperationAccepted(socket, deleteCommand!.requestId!, { workspaceId: 'alpha:ws-1' });
    sendOperationEvent(socket, deleteCommand!.requestId!, {
      workspaceId: 'alpha:ws-1',
      state: 'failed',
      message: 'Remove scripts failed: cleanup failed',
      error: { code: 'REMOVE_SCRIPT_FAILED', message: 'Remove scripts failed: cleanup failed' },
    });

    await expect(deletePromise).rejects.toMatchObject({
      message: 'Remove scripts failed: cleanup failed',
      code: 'REMOVE_SCRIPT_FAILED',
    });
  });

  it('rejects pending workspace delete immediately when socket closes', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const deletePromise = backend.deleteWorkspace('alpha', 'ws-1');
    socket.handlers?.onClose();

    await expect(deletePromise).rejects.toMatchObject({
      message: 'Remote session disconnected',
      code: 'DELETE_FAILED',
    });
  });

  it('keeps workspace delete pending after acceptance until final operation event', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const deletePromise = backend.deleteWorkspace('alpha', 'alpha:ws-timeout');
    await Bun.sleep(0);
    const deleteCommand = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]) as { requestId?: string } | null;
    sendOperationAccepted(socket, deleteCommand!.requestId!, { workspaceId: 'alpha:ws-timeout' });

    const statusBeforeFinal = await Promise.race([
      deletePromise.then(() => 'resolved', () => 'rejected'),
      Bun.sleep(0).then(() => 'pending'),
    ]);
    expect(statusBeforeFinal).toBe('pending');

    sendOperationEvent(socket, deleteCommand!.requestId!, {
      workspaceId: 'alpha:ws-timeout',
      state: 'succeeded',
      result: { type: 'workspace_deleted', requestId: deleteCommand!.requestId, workspaceId: 'alpha:ws-timeout' },
    });

    await expect(deletePromise).resolves.toBeUndefined();
  });

  it('resolves workspace delete from a terminal operation snapshot', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const deletePromise = backend.deleteWorkspace('alpha', 'alpha:ws-snapshot');
    await Bun.sleep(0);
    const deleteCommand = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]) as { requestId?: string } | null;
    sendOperationAccepted(socket, deleteCommand!.requestId!, { workspaceId: 'alpha:ws-snapshot' });
    sendOperationSnapshot(socket, [
      makeOperationRecord(deleteCommand!.requestId!, {
        workspaceId: 'alpha:ws-snapshot',
        state: 'succeeded',
        result: { type: 'workspace_deleted', requestId: deleteCommand!.requestId, workspaceId: 'alpha:ws-snapshot' },
      }),
    ]);

    await expect(deletePromise).resolves.toBeUndefined();
  });

  it('removes dismissed operations on ack and keeps waiters settling from final events', async () => {
    const socket = createFakeSocket();
    const events: BackendEvent[] = [];
    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });
    backend.onEvent((event) => events.push(event));

    await connectAndHandshake(backend, socket);

    const deletePromise = backend.deleteWorkspace('alpha', 'alpha:ws-dismiss');
    await Bun.sleep(0);
    const deleteCommand = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]) as { requestId?: string } | null;
    sendOperationAccepted(socket, deleteCommand!.requestId!, { workspaceId: 'alpha:ws-dismiss' });
    const operationId = deleteCommand!.requestId!;

    await backend.dismissOperation(operationId);
    const dismissCommand = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]);
    expect(dismissCommand).toEqual({ type: 'dismiss_operation', operationId });
    sendOperationDismissed(socket, operationId);
    await Bun.sleep(0);
    expect(events).toContainEqual({ type: 'operation_dismissed', operationId });

    sendOperationEvent(socket, deleteCommand!.requestId!, {
      workspaceId: 'alpha:ws-dismiss',
      state: 'succeeded',
      result: { type: 'workspace_deleted', requestId: deleteCommand!.requestId, workspaceId: 'alpha:ws-dismiss' },
    });

    await expect(deletePromise).resolves.toBeUndefined();
  });

  it('waits for the matching delete operation event', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const deletePromise = backend.deleteWorkspace('alpha', 'alpha:ws-target');
    await Bun.sleep(0);
    const deleteCommand = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]) as { requestId?: string } | null;
    sendOperationAccepted(socket, deleteCommand!.requestId!, { workspaceId: 'alpha:ws-target' });
    sendOperationEvent(socket, 'unrelated-operation', {
      workspaceId: 'alpha:ws-other',
      state: 'succeeded',
      result: { type: 'workspace_deleted', requestId: 'unrelated-operation', workspaceId: 'alpha:ws-other' },
    });
    const statusAfterUnrelatedOperation = await Promise.race([
      deletePromise.then(() => 'resolved', () => 'rejected'),
      Bun.sleep(0).then(() => 'pending'),
    ]);
    expect(statusAfterUnrelatedOperation).toBe('pending');
    sendOperationEvent(socket, deleteCommand!.requestId!, {
      workspaceId: 'alpha:ws-target',
      state: 'succeeded',
      result: { type: 'workspace_deleted', requestId: deleteCommand!.requestId, workspaceId: 'alpha:ws-target' },
    });

    await expect(deletePromise).resolves.toBeUndefined();
  });

  it('rejects delete on the matching failed operation event', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const deletePromise = backend.deleteWorkspace('alpha', 'alpha:ws-target');
    await Bun.sleep(0);
    const deleteCommand = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]) as { requestId?: string } | null;
    sendOperationAccepted(socket, deleteCommand!.requestId!, { workspaceId: 'alpha:ws-target' });
    sendOperationEvent(socket, 'unrelated-failed-operation', {
      workspaceId: 'alpha:ws-other',
      state: 'failed',
      message: 'wrong workspace error',
      error: { code: 'DELETE_FAILED', message: 'wrong workspace error' },
    });

    const statusAfterMismatch = await Promise.race([
      deletePromise.then(() => 'resolved', () => 'rejected'),
      Bun.sleep(0).then(() => 'pending'),
    ]);
    expect(statusAfterMismatch).toBe('pending');

    sendOperationEvent(socket, deleteCommand!.requestId!, {
      workspaceId: 'alpha:ws-target',
      state: 'failed',
      message: 'target workspace error',
      error: { code: 'DELETE_FAILED', message: 'target workspace error' },
    });

    await expect(deletePromise).rejects.toMatchObject({
      message: 'target workspace error',
      code: 'DELETE_FAILED',
    });
  });

  it('rejects delete on permission error when workspace id is provided', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const deletePromise = backend.deleteWorkspace('alpha', 'alpha:ws-target');
    await Bun.sleep(0);
    const deleteCommand = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]) as { requestId?: string } | null;
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'error',
        code: 'PERMISSION_DENIED',
        message: 'Requires full access to delete workspaces',
        workspaceId: 'alpha:ws-target',
        requestId: deleteCommand?.requestId,
      })
    );

    await expect(deletePromise).rejects.toMatchObject({
      message: 'Requires full access to delete workspaces',
      code: 'PERMISSION_DENIED',
    });
  });

  it('does not reject delete for unrelated error without workspace id', async () => {
    const socket = createFakeSocket();

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const deletePromise = backend.deleteWorkspace('alpha', 'alpha:ws-target');
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'error',
        code: 'NOT_FOUND',
        message: 'Session not found',
      })
    );

    const statusAfterUnrelatedError = await Promise.race([
      deletePromise.then(() => 'resolved', () => 'rejected'),
      Bun.sleep(0).then(() => 'pending'),
    ]);
    expect(statusAfterUnrelatedError).toBe('pending');

    socket.handlers?.onClose();
    await expect(deletePromise).rejects.toMatchObject({
      message: 'Remote session disconnected',
      code: 'DELETE_FAILED',
    });
  });
  it('rethrows structured service-start conflicts as PortConflictError', async () => {
    const socket = createFakeSocket();
    const conflict = { port: 3000, protocol: 'http' as const, pid: 1234, command: 'node' };

    const backend = new RemoteSessionBackend({
      descriptor: {
        key: buildRemoteBackendKey('wss://relay.test/ws', 'machine-1'),
        kind: 'remote',
        label: 'Machine 1',
        relayUrl: 'wss://relay.test/ws',
        machineId: 'machine-1',
      },
      socket,
      socketAdapter,
      identity,
      machineId: 'machine-1',
      deviceCertificate: 'test-device-cert',
      signer: (message) => ({ ...message, signature: { sig: 'x' } }),
      crypto: cryptoAdapter,
      handshake: handshakeAdapter,
    });

    await connectAndHandshake(backend, socket);

    const pending = backend.startProcess('project:workspace', 'web', 1);
    await Bun.sleep(0);
    const sent = decodeRelayDataCommand(cryptoAdapter, socket.sent.at(-1) ?? '') as { requestId: string; type: string };
    expect(sent.type).toBe('start_process');

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'command_response',
        requestId: sent.requestId,
        response: {
          type: 'error',
          code: 'PORT_CONFLICT',
          message: 'Failed to start service: Cannot start web; port already in use: :3000 -> node (pid 1234)',
          processName: 'web',
          portConflicts: [conflict],
        },
      }),
    );

    let thrown: unknown;
    try {
      await pending;
      expect.unreachable('Expected startProcess to throw');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(PortConflictError);
    expect(thrown).toMatchObject({
      name: 'PortConflictError',
      code: 'PORT_CONFLICT',
      conflicts: [conflict],
    });
  });

  it('opts into machine deltas, applies contiguous machine_event pushes, and resyncs on a nonce gap', async () => {
    const socket = createFakeSocket();
    const backend = createBackend(socket);
    const events: BackendEvent[] = [];
    backend.onEvent((event) => events.push(event));

    await connectAndHandshake(backend, socket);
    await Bun.sleep(0);

    // Handshake completion fires the additive watch_machine_events opt-in.
    const sentCommands = socket.sent
      .map((raw) => decodeRelayDataCommand(cryptoAdapter, raw))
      .filter((cmd): cmd is { type: string; requestId?: string } => !!cmd && typeof cmd === 'object');
    const watchRequest = sentCommands.find((cmd) => cmd.type === 'watch_machine_events');
    expect(watchRequest).toBeDefined();

    // Machine answers with the baseline snapshot for the delta nonce chain.
    const baseline = { ...createMachineSnapshotWithWorkspace(), snapshotNonce: 10 };
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'refresh_machine_snapshot',
        requestId: watchRequest!.requestId,
        snapshot: baseline,
      }),
    );
    await Bun.sleep(0);

    // Contiguous delta (nonce 11) applies to the reducer-facing model.
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'machine_event',
        event: {
          type: 'workspace-upserted',
          snapshotNonce: 11,
          workspace: {
            ...createMachineSnapshotWithWorkspace().workspacesById['alpha:ws-1'],
            phase: 'review',
          },
        },
      }),
    );
    await Bun.sleep(0);

    const applied = events
      .filter((event): event is Extract<BackendEvent, { type: 'machine_snapshot' }> => event.type === 'machine_snapshot')
      .at(-1)?.snapshot;
    expect(applied?.snapshotNonce).toBe(11);
    expect(applied?.workspacesById['alpha:ws-1']?.phase).toBe('review');

    // Gap (nonce 15 while we sit at 11) → the backend requests a full refresh.
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'machine_event',
        event: { type: 'workspace-removed', snapshotNonce: 15, workspaceId: 'alpha:ws-1' },
      }),
    );
    await Bun.sleep(0);

    const refreshRequest = socket.sent
      .map((raw) => decodeRelayDataCommand(cryptoAdapter, raw))
      .filter((cmd): cmd is { type: string; requestId?: string } => !!cmd && typeof cmd === 'object')
      .find((cmd) => cmd.type === 'refresh_machine_snapshot');
    expect(refreshRequest).toBeDefined();

    // The gapped event must NOT have been applied.
    const beforeResync = events
      .filter((event): event is Extract<BackendEvent, { type: 'machine_snapshot' }> => event.type === 'machine_snapshot')
      .at(-1)?.snapshot;
    expect(beforeResync?.workspacesById['alpha:ws-1']).toBeDefined();

    // Resync response replaces the model wholesale.
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'refresh_machine_snapshot',
        requestId: refreshRequest!.requestId,
        snapshot: { ...createEmptyMachineSnapshot(), snapshotNonce: 20 },
      }),
    );
    await Bun.sleep(0);

    const resynced = events
      .filter((event): event is Extract<BackendEvent, { type: 'machine_snapshot' }> => event.type === 'machine_snapshot')
      .at(-1)?.snapshot;
    expect(resynced?.snapshotNonce).toBe(20);
    expect(resynced?.workspacesById['alpha:ws-1']).toBeUndefined();
  });

  it('maps a Shake RPC through the relay and preserves its structured result', async () => {
    const socket = createFakeSocket();
    const backend = createBackend(socket);
    await connectAndHandshake(backend, socket);
    let stopObservingSnapshot: () => void = () => {};
    const workspaceSnapshotApplied = new Promise<void>((resolve) => {
      stopObservingSnapshot = backend.onEvent((event) => {
        if (event.type === 'machine_snapshot' && event.snapshot.workspacesById['alpha:ws-1']) {
          stopObservingSnapshot();
          resolve();
        }
      });
    });
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'machine_snapshot',
        snapshot: createMachineSnapshotWithWorkspace(),
      }),
    );
    await workspaceSnapshotApplied;

    const shakeRequestSent = new Promise<ShakeAgentSessionRequest>((resolve) => {
      socket.onSend = (raw) => {
        const candidate = decodeRelayDataCommand(cryptoAdapter, raw);
        if (isShakeAgentSessionRequest(candidate)) resolve(candidate);
      };
    });
    const pending = backend.shakeAgentSession('alpha:ws-1', 'agent-1', 'elide');
    const request = await shakeRequestSent;
    socket.onSend = undefined;
    expect(request).toMatchObject({
      type: 'shake_agent_session',
      target: {
        workspaceId: 'alpha:ws-1',
        workspaceName: 'ws-1',
        workspacePath: '/tmp/alpha/ws-1',
        projectName: 'alpha',
      },
      agentSessionId: 'agent-1',
      mode: 'elide',
    });

    const result = {
      mode: 'elide' as const,
      toolResultsDropped: 5,
      blocksDropped: 2,
      tokensFreed: 2400,
      artifactId: 'artifact://elided-source',
    };
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'command_response',
        requestId: request.requestId,
        response: { type: 'agent-shake-result', result },
      }),
    );

    await expect(pending).resolves.toEqual(result);
  });

  it('rejects a Shake RPC when the relay returns its correlated error', async () => {
    const socket = createFakeSocket();
    const backend = createBackend(socket);
    await connectAndHandshake(backend, socket);
    let stopObservingSnapshot: () => void = () => {};
    const workspaceSnapshotApplied = new Promise<void>((resolve) => {
      stopObservingSnapshot = backend.onEvent((event) => {
        if (event.type === 'machine_snapshot' && event.snapshot.workspacesById['alpha:ws-1']) {
          stopObservingSnapshot();
          resolve();
        }
      });
    });
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'machine_snapshot',
        snapshot: createMachineSnapshotWithWorkspace(),
      }),
    );
    await workspaceSnapshotApplied;

    const shakeRequestSent = new Promise<ShakeAgentSessionRequest>((resolve) => {
      socket.onSend = (raw) => {
        const candidate = decodeRelayDataCommand(cryptoAdapter, raw);
        if (isShakeAgentSessionRequest(candidate)) resolve(candidate);
      };
    });
    const pending = backend.shakeAgentSession('alpha:ws-1', 'agent-1', 'images');
    const request = await shakeRequestSent;
    socket.onSend = undefined;
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'error',
        requestId: request.requestId,
        message: 'Failed to shake context: session is busy',
      }),
    );

    await expect(pending).rejects.toThrow('Failed to shake context: session is busy');
  });

  it('keeps a remote Shake pending beyond the ordinary typed-RPC deadline until its response arrives', async () => {
    const socket = createFakeSocket();
    const backend = createBackend(socket);
    await connectAndHandshake(backend, socket);
    let stopObservingSnapshot: () => void = () => {};
    const workspaceSnapshotApplied = new Promise<void>((resolve) => {
      stopObservingSnapshot = backend.onEvent((event) => {
        if (event.type === 'machine_snapshot' && event.snapshot.workspacesById['alpha:ws-1']) {
          stopObservingSnapshot();
          resolve();
        }
      });
    });
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'machine_snapshot',
        snapshot: createMachineSnapshotWithWorkspace(),
      }),
    );
    await workspaceSnapshotApplied;

    const shakeRequestSent = new Promise<ShakeAgentSessionRequest>((resolve) => {
      socket.onSend = (raw) => {
        const candidate = decodeRelayDataCommand(cryptoAdapter, raw);
        if (isShakeAgentSessionRequest(candidate)) resolve(candidate);
      };
    });
    jest.useFakeTimers();
    try {
      const pending = backend.shakeAgentSession('alpha:ws-1', 'agent-1', 'images');
      const request = await shakeRequestSent;
      socket.onSend = undefined;
      let settled = false;
      void pending.then(
        () => { settled = true; },
        () => { settled = true; },
      );

      jest.advanceTimersByTime(12_001);
      await Promise.resolve();
      expect(settled).toBe(false);

      const result = {
        mode: 'images' as const,
        toolResultsDropped: 0,
        blocksDropped: 0,
        tokensFreed: 3200,
      };
      socket.handlers?.onMessage(
        makeRelayDataPayload(cryptoAdapter, {
          type: 'command_response',
          requestId: request.requestId,
          response: { type: 'agent-shake-result', result },
        }),
      );
      await expect(pending).resolves.toEqual(result);
    } finally {
      jest.useRealTimers();
    }
  });

});
