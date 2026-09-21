import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RELAY_HEARTBEAT_INTERVAL_MS,
  RELAY_HEARTBEAT_TIMEOUT_MS,
  RELAY_PROTOCOL_VERSION,
  type RelaySocketMessage,
} from '@gitspace/protocol';
import { credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol/credential-vault';
import { MachineRelayConnector } from '../src/relay-connector.js';

const privateKey = new Uint8Array(32).fill(7);
const machineGrant = signCredentialAuthorityGrant({
  version: 1,
  userId: 'relay-test',
  machineId: 'machine-test',
  signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(privateKey)),
  exchangePublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(privateKey)),
  capabilities: ['space.control'],
  generation: 1,
}, privateKey);

class Socket extends EventTarget {
  static readonly OPEN = 1;
  static readonly instances: Socket[] = [];
  readyState = 0;
  readonly sent: RelaySocketMessage[] = [];

  constructor(readonly url: URL) {
    super();
    Socket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  send(input: string): void {
    if (this.readyState !== 1) throw new Error('Socket is not open');
    this.sent.push(JSON.parse(input));
  }

  receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
  }

  terminate(): void {
    // Intentionally no close event: a silent transport must not depend on one.
    this.readyState = 3;
  }
}

let now = 0;
let nextTimer = 0;
const timers = new Map<number, { at: number; callback: () => void }>();
let connector: MachineRelayConnector;
const originalSocket = globalThis.WebSocket;

beforeEach(() => {
  now = 0;
  nextTimer = 0;
  timers.clear();
  Socket.instances.length = 0;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { at: now + delay, callback });
    return id;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id: number) => {
    timers.delete(id);
  }) as typeof clearTimeout);
  connector = new MachineRelayConnector({
    relayUrl: 'https://relay.test',
    machineId: 'machine-test',
    machineGrant,
    signingPrivateKey: privateKey,
    localOrigin: 'http://127.0.0.1:8081',
  });
});

afterEach(() => {
  connector.stop();
  globalThis.WebSocket = originalSocket;
  vi.restoreAllMocks();
});

function advance(ms: number): void {
  const until = now + ms;
  while (true) {
    const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) break;
    timers.delete(due[0]);
    now = due[1].at;
    due[1].callback();
  }
  now = until;
}

function request(socket: Socket, requestId: string): void {
  socket.receive({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.request.start', requestId, method: 'POST', path: '/rpc', headers: [] });
  socket.receive({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.request.end', requestId });
}

describe('MachineRelayConnector transport recovery', () => {
  it('recovers a silent open socket, rejects unrelated echoes, and ignores late events from the old connection', () => {
    connector.start();
    const stale = Socket.instances[0]!;
    stale.open();
    const firstHeartbeat = stale.sent[0]!;
    expect(firstHeartbeat).toMatchObject({ type: 'frame', to: 'machine:machine-test' });
    stale.receive({ ...firstHeartbeat, payload: 'not-the-outstanding-nonce' });
    advance(RELAY_HEARTBEAT_TIMEOUT_MS);
    expect(stale.readyState).toBe(3);
    advance(500);
    const live = Socket.instances[1]!;
    live.open();
    live.receive(live.sent[0]);
    stale.receive(firstHeartbeat);
    stale.dispatchEvent(new Event('error'));
    advance(RELAY_HEARTBEAT_INTERVAL_MS);
    live.receive(live.sent[1]);
    advance(RELAY_HEARTBEAT_TIMEOUT_MS);
    expect(live.readyState).toBe(1);
    expect(Socket.instances).toHaveLength(2);
    connector.stop();
    advance(60_000);
    expect(Socket.instances).toHaveLength(2);
  });

  it('bounds a hung upgrade and reconnects on an error even without close', () => {
    connector.start();
    const connecting = Socket.instances[0]!;
    advance(15_000);
    expect(connecting.readyState).toBe(3);
    advance(500);
    const failed = Socket.instances[1]!;
    failed.dispatchEvent(new Event('error'));
    advance(1_000);
    expect(failed.readyState).toBe(3);
    expect(Socket.instances).toHaveLength(3);
  });

  it('aborts a disconnected mutation transport without replaying it after reconnect', async () => {
    const aborted = Promise.withResolvers<void>();
    let mutations = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      mutations++;
      return await new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => {
          aborted.resolve();
          reject(new DOMException('Transport aborted', 'AbortError'));
        }, { once: true });
      });
    });
    connector.start();
    const stale = Socket.instances[0]!;
    stale.open();
    stale.receive(stale.sent[0]);
    const requestId = crypto.randomUUID();
    request(stale, requestId);
    expect(mutations).toBe(1);
    advance(RELAY_HEARTBEAT_INTERVAL_MS + RELAY_HEARTBEAT_TIMEOUT_MS);
    await aborted.promise;
    advance(500);
    const live = Socket.instances[1]!;
    live.open();
    live.receive(live.sent[0]);
    request(stale, requestId);
    expect(mutations).toBe(1);
    expect(live.sent.every((message) => message.type === 'frame')).toBe(true);
  });

  it('cancels a partial request without executing it or tearing down the healthy connection', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    connector.start();
    const socket = Socket.instances[0]!;
    socket.open();
    socket.receive(socket.sent[0]);
    const requestId = crypto.randomUUID();
    socket.receive({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.request.start', requestId, method: 'POST', path: '/rpc', headers: [] });
    socket.receive({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.request.cancel', requestId });
    socket.receive({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.request.end', requestId });
    expect(fetch).not.toHaveBeenCalled();
    advance(RELAY_HEARTBEAT_INTERVAL_MS);
    socket.receive(socket.sent[1]);
    expect(socket.readyState).toBe(1);
  });
});
