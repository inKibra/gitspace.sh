import { describe, expect, it } from 'bun:test';
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
import { PortConflictError } from '../../lib/processes/ports.js';

interface FakeSocket {
  readyState: number;
  handlers: RemoteSessionSocketHandlers | null;
  sent: string[];
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

describe('RemoteSessionBackend', () => {
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
    });
    expect(ptyChunks).toEqual(['setup output']);
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
    expect(sent.type).toBe('tmux_command');

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'tmux_command_response',
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

    ((backend as unknown) as { mode: 'attached' | 'browsing' }).mode = 'attached';

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

    expect(ptyChunks).toEqual([
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

    ((backend as unknown) as { mode: 'attached' | 'browsing' }).mode = 'attached';

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
    expect(callbackTwoOutput).toEqual(['while-cleared', 'after-restore']);
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
    expect(command).toMatchObject({ type: 'tmux_command' });
    const requestId = (command as { requestId: string }).requestId;
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'tmux_command_response',
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
        type: 'tmux_command_response',
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
      sessionId: 'existing-session',
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
    const deleteCommand = decodeRelayDataCommand(cryptoAdapter, socket.sent[socket.sent.length - 1]);
    expect(deleteCommand).toEqual({
      type: 'delete_workspace',
      projectName: 'alpha',
      workspaceId: 'ws-1',
      scriptPolicy: 'skip',
    });

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'workspace_deleted',
        workspaceId: 'ws-1',
      })
    );

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
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'error',
        code: 'REMOVE_SCRIPT_FAILED',
        message: 'Remove scripts failed: cleanup failed',
        workspaceId: 'ws-1',
      })
    );

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

  it('times out pending workspace delete when no response arrives', async () => {
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

    const deletePromise = backend.deleteWorkspace('alpha', 'alpha:ws-timeout', {
      timeoutMs: 5,
    });

    await expect(deletePromise).rejects.toMatchObject({
      name: 'WorkspaceDeleteError',
      code: 'DELETE_TIMEOUT',
    });
  });

  it('ignores workspace_deleted for a different workspace', async () => {
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
        type: 'workspace_deleted',
        workspaceId: 'alpha:ws-other',
      })
    );

    const statusAfterMismatch = await Promise.race([
      deletePromise.then(() => 'resolved', () => 'rejected'),
      Bun.sleep(0).then(() => 'pending'),
    ]);
    expect(statusAfterMismatch).toBe('pending');

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'workspace_deleted',
        workspaceId: 'alpha:ws-target',
      })
    );

    await expect(deletePromise).resolves.toBeUndefined();
  });

  it('ignores delete error for a different workspace id', async () => {
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
        code: 'DELETE_FAILED',
        message: 'wrong workspace error',
        workspaceId: 'alpha:ws-other',
      })
    );

    const statusAfterMismatch = await Promise.race([
      deletePromise.then(() => 'resolved', () => 'rejected'),
      Bun.sleep(0).then(() => 'pending'),
    ]);
    expect(statusAfterMismatch).toBe('pending');

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'error',
        code: 'DELETE_FAILED',
        message: 'target workspace error',
        workspaceId: 'alpha:ws-target',
      })
    );

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
    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'error',
        code: 'PERMISSION_DENIED',
        message: 'Requires full access to delete workspaces',
        workspaceId: 'alpha:ws-target',
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
    expect(sent.type).toBe('tmux_command');

    socket.handlers?.onMessage(
      makeRelayDataPayload(cryptoAdapter, {
        type: 'tmux_command_response',
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

});
