import { ed25519 } from '@noble/curves/ed25519.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RELAY_HEARTBEAT_INTERVAL_MS,
  RELAY_HEARTBEAT_MODE,
  RELAY_HEARTBEAT_TIMEOUT_MS,
  RELAY_NOTICE_MODE,
  RELAY_NOTICE_TOPICS,
  RELAY_PING_MESSAGE,
  RELAY_PONG_MESSAGE,
  RELAY_PROTOCOL_VERSION,
  type MachineLiveNotice,
  type RelayNotice,
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
  readonly sent: string[] = [];

  constructor(readonly url: URL, readonly options: { headers: Record<string, string> }) {
    super();
    Socket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  send(input: string): void {
    if (this.readyState !== 1) throw new Error('Socket is not open');
    this.sent.push(input);
  }

  receive(message: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: typeof message === 'string' ? message : JSON.stringify(message) }));
  }

  /** The relay's auto-response to the fixed ping. */
  pong(): void {
    this.receive(RELAY_PONG_MESSAGE);
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
  it('pings for liveness, recovers a silent open socket, and ignores late events from the old connection', () => {
    connector.start();
    const stale = Socket.instances[0]!;
    expect(stale.url.searchParams.get('heartbeat')).toBe(RELAY_HEARTBEAT_MODE);
    stale.open();
    expect(stale.sent).toEqual([RELAY_PING_MESSAGE]);
    advance(RELAY_HEARTBEAT_TIMEOUT_MS);
    expect(stale.readyState).toBe(3);
    advance(500);
    const live = Socket.instances[1]!;
    live.open();
    live.pong();
    stale.pong();
    stale.dispatchEvent(new Event('error'));
    advance(RELAY_HEARTBEAT_INTERVAL_MS);
    expect(live.sent).toEqual([RELAY_PING_MESSAGE, RELAY_PING_MESSAGE]);
    live.pong();
    advance(RELAY_HEARTBEAT_TIMEOUT_MS);
    expect(live.readyState).toBe(1);
    expect(Socket.instances).toHaveLength(2);
    connector.stop();
    advance(60_000);
    expect(Socket.instances).toHaveLength(2);
  });

  it('a pong with no ping outstanding does not stand in for the next answer', () => {
    connector.start();
    const socket = Socket.instances[0]!;
    socket.open();
    socket.pong();
    socket.pong();
    advance(RELAY_HEARTBEAT_INTERVAL_MS);
    advance(RELAY_HEARTBEAT_TIMEOUT_MS);
    expect(socket.readyState).toBe(3);
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
    stale.pong();
    const requestId = crypto.randomUUID();
    request(stale, requestId);
    expect(mutations).toBe(1);
    advance(RELAY_HEARTBEAT_INTERVAL_MS + RELAY_HEARTBEAT_TIMEOUT_MS);
    await aborted.promise;
    advance(500);
    const live = Socket.instances[1]!;
    live.open();
    live.pong();
    request(stale, requestId);
    expect(mutations).toBe(1);
    expect(live.sent.every((message) => message === RELAY_PING_MESSAGE)).toBe(true);
  });

  it('cancels a partial request without executing it or tearing down the healthy connection', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    connector.start();
    const socket = Socket.instances[0]!;
    socket.open();
    socket.pong();
    const requestId = crypto.randomUUID();
    socket.receive({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.request.start', requestId, method: 'POST', path: '/rpc', headers: [] });
    socket.receive({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.request.cancel', requestId });
    socket.receive({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.request.end', requestId });
    expect(fetch).not.toHaveBeenCalled();
    advance(RELAY_HEARTBEAT_INTERVAL_MS);
    socket.pong();
    expect(socket.readyState).toBe(1);
  });

  it('logs the close frame, connection age, and aborted forwards when the relay closes the socket', async () => {
    const aborted = Promise.withResolvers<void>();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      init!.signal!.addEventListener('abort', () => {
        aborted.resolve();
        reject(new DOMException('Transport aborted', 'AbortError'));
      }, { once: true });
      return await promise;
    });
    now = 1_000;
    connector.start();
    const socket = Socket.instances[0]!;
    socket.open();
    socket.pong();
    request(socket, crypto.randomUUID());
    advance(4_321);
    socket.dispatchEvent(new CloseEvent('close', { code: 1008, reason: 'Machine authorization expired or was revoked' }));
    await aborted.promise;
    const closed = warn.mock.calls.map(([line]) => JSON.parse(String(line))).find((line) => line.event === 'relay_closed');
    expect(closed).toMatchObject({
      cause: 'close', code: 1008, reason: 'Machine authorization expired or was revoked', connectionAgeMs: 4_321, abortedRequests: 1,
    });
    expect(new Date(closed.at).toISOString()).toBe(closed.at);
  });

  it('re-reads the relay clock after an upgrade that never opened and signs later attempts with it', async () => {
    const skewMs = 5 * 60_000;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const probe = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { headers: { date: new Date(Date.now() + skewMs).toUTCString() } }));
    const signedAt = (socket: Socket) => Number(/^GitSpace (\d+)\./u.exec(socket.options.headers.authorization ?? '')?.[1]);
    connector.start();
    const rejected = Socket.instances[0]!;
    expect(Math.abs(signedAt(rejected) - Date.now())).toBeLessThan(1_000);
    rejected.dispatchEvent(new Event('error'));
    expect(probe).toHaveBeenCalledWith('https://relay.test', expect.objectContaining({ method: 'HEAD' }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    advance(500);
    expect(Math.abs(signedAt(Socket.instances[1]!) - (Date.now() + skewMs))).toBeLessThan(60_000);
  });
});

describe('MachineRelayConnector notices', () => {
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const keys = (batch: RelayNotice[]) => batch.flatMap((notice) => notice.topics.map((topic) => `${topic}:${notice.workspaceId ?? '*'}`)).sort();

  it('catches up on every topic each time a connection opens and coalesces notices behind a delivery', async () => {
    const batches: RelayNotice[][] = [];
    const deliveries: Array<PromiseWithResolvers<void>> = [];
    connector = new MachineRelayConnector({
      relayUrl: 'https://relay.test', machineId: 'machine-test', machineGrant, signingPrivateKey: privateKey, localOrigin: 'http://127.0.0.1:8081',
      onNotice: async (batch) => {
        batches.push(batch);
        const delivery = Promise.withResolvers<void>();
        deliveries.push(delivery);
        await delivery.promise;
      },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    connector.start();
    const first = Socket.instances[0]!;
    expect(first.url.searchParams.get('notices')).toBe(RELAY_NOTICE_MODE);
    first.open();
    await settle();
    expect(batches).toEqual([[{ topics: [...RELAY_NOTICE_TOPICS] }]]);
    // Delivery is in flight: repeats of one topic and workspace collapse into the single next delivery.
    for (const notice of [
      { topics: ['assignments'], workspaceId: 'workspace-a' },
      { topics: ['workspace.snapshot', 'assignments'], workspaceId: 'workspace-a' },
      { topics: ['release'] },
      { topics: ['release'] },
    ]) first.receive({ version: RELAY_PROTOCOL_VERSION, type: 'notice', ...notice });
    await settle();
    expect(batches).toHaveLength(1);
    deliveries[0]!.resolve();
    await settle();
    expect(batches).toHaveLength(2);
    expect(keys(batches[1]!)).toEqual(['assignments:workspace-a', 'release:*', 'workspace.snapshot:workspace-a']);
    deliveries[1]!.resolve();
    await settle();
    first.dispatchEvent(new Event('error'));
    advance(500);
    Socket.instances[1]!.open();
    await settle();
    expect(batches).toHaveLength(3);
    expect(batches[2]).toEqual([{ topics: [...RELAY_NOTICE_TOPICS] }]);
    deliveries[2]!.resolve();
  });
});

describe('MachineRelayConnector live notices', () => {
  it('sends live notices only on an open connection and hands unwatched reports to the machine', () => {
    const unwatched: MachineLiveNotice[] = [];
    connector = new MachineRelayConnector({
      relayUrl: 'https://relay.test', machineId: 'machine-test', machineGrant, signingPrivateKey: privateKey, localOrigin: 'http://127.0.0.1:8081',
      onUnwatched: (notice) => { unwatched.push(notice); },
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const notice = { workspace: 'workspace-a', resource: 'terminals:workspace-a:machine-test:', cursor: 7 };
    connector.start();
    const socket = Socket.instances[0]!;
    // Before the connection opens the notice is dropped: the relay announces each connection, and tabs read again.
    connector.liveNotice(notice);
    socket.open();
    connector.liveNotice(notice);
    expect(socket.sent.filter((sent) => sent !== RELAY_PING_MESSAGE).map((sent) => JSON.parse(sent))).toEqual([{ version: RELAY_PROTOCOL_VERSION, type: 'live.notice', ...notice }]);
    socket.receive({ version: RELAY_PROTOCOL_VERSION, type: 'live.unwatched', ...notice });
    expect(unwatched).toEqual([notice]);
  });
});
