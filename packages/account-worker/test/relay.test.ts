import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  RELAY_HEARTBEAT_LEASE_MS,
  RELAY_HEARTBEAT_MODE,
  RELAY_PROTOCOL_VERSION,
  createRelayAuthorization,
  createDeviceBinding,
  signDeviceInvite,
  signRpcDigestRequest,
  decodeTunnelChunk,
  encodeTunnelChunk,
  tunnelRequestMessageSchema,
  type TunnelRequestMessage,
} from '@gitspace/protocol';
import {
  credentialProtocolBase64,
  signCredentialAuthorityGrant,
  type SignedCredentialAuthorityGrant,
} from '@gitspace/protocol/credential-vault';
import relayWorker, { CredentialVaultDO, UserRelayDO } from '../src/index.js';
import { SERVICE_ASSERTION_HEADER, verifyServiceAssertion } from '@gitspace/protocol/service-access';
import { fetchInternalService } from '../src/service-access.js';

const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const machinePrivateKey = Uint8Array.from({ length: 32 }, (_, index) => 100 + index);
const machineGrant: SignedCredentialAuthorityGrant = signCredentialAuthorityGrant({
  version: 1,
  userId: env.ACCOUNT_ID,
  machineId: 'darktop',
  signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machinePrivateKey)),
  exchangePublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machinePrivateKey)),
  capabilities: ['storage.access', 'space.control'],
  generation: 1,
}, privateKey);

beforeEach(async () => {
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({
    userId: env.ACCOUNT_ID,
    rootPublicKey: env.AUTH_PUBLIC_KEY,
    vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(49)),
  });
  await vault.registerDevice(machineGrant);
});

/** The vault read behind the isolate's registry fails; authentication survives only while the cached copy is fresh enough. */
function interruptAuthority() {
  vi.spyOn(CredentialVaultDO.prototype, 'deviceRegistrySnapshot').mockImplementation(() => { throw new Error('Authority unavailable'); });
}

afterEach(async () => {
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (_instance, state) => {
    for (const socket of state.getWebSockets()) socket.close(1000, 'test complete');
    await state.storage.deleteAlarm();
  });
  vi.restoreAllMocks();
});

function authorizedRequest(url: string, init: RequestInit = {}): Request {
  const parsed = new URL(url);
  const target = `${parsed.pathname}${parsed.search}`;
  const headers = new Headers(init.headers);
  headers.set('authorization', createRelayAuthorization(privateKey, target));
  return new Request(url, { ...init, headers });
}
function machineAuthorizedRequest(url: string, init: RequestInit = {}, key: Uint8Array = machinePrivateKey, grant = machineGrant): Request {
  const parsed = new URL(url);
  const target = `${parsed.pathname}${parsed.search}`;
  const headers = new Headers(init.headers);
  headers.set('authorization', createRelayAuthorization(key, target));
  headers.set('x-gitspace-machine-grant', btoa(JSON.stringify(grant)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, ''));
  return new Request(url, { ...init, headers });
}

async function enrollServiceBrowser() {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const invite = signDeviceInvite({ version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read', 'rpc.write'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://api.gitspace.sh' }, privateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(key)), label: 'Service browser', boundAt: Date.now(), signingPrivateKey: key });
  const result = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).enrollDevice({ invite, binding });
  if (result.status !== 'ok') throw new Error(result.error.message);
  return { deviceId: binding.deviceId, signingPrivateKey: key };
}


async function openSocket(role: 'machine' | 'client', id: string, heartbeat = false): Promise<WebSocket> {
  const request = role === 'machine' ? machineAuthorizedRequest : authorizedRequest;
  const response = await exports.default.fetch(request(
    `https://relay.test/ws?role=${role}&id=${id}${heartbeat ? `&heartbeat=${RELAY_HEARTBEAT_MODE}` : ''}`,
    { headers: { upgrade: 'websocket' } },
  ));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error('Expected relay WebSocket');
  response.webSocket.accept();
  return response.webSocket;
}

function nextMessage(socket: WebSocket): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') resolve(event.data);
    else reject(new Error('Expected text WebSocket message'));
  }, { once: true });
  return promise;
}

function parseTunnelRequest(input: string): TunnelRequestMessage {
  const parsed = tunnelRequestMessageSchema.safeParse(JSON.parse(input));
  if (!parsed.success) throw new Error(`Invalid tunnel request: ${parsed.error.message}`);
  return parsed.data;
}

async function ciphertextHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('portable RelayDO', () => {
  it('routes opaque frames between hibernatable endpoints', async () => {
    const machine = await openSocket('machine', 'darktop');
    const client = await openSocket('client', 'browser');
    const received = nextMessage(client);
    const frame = {
      version: RELAY_PROTOCOL_VERSION,
      type: 'frame',
      to: 'client:browser',
      payload: 'opaque-ciphertext',
    };
    machine.send(JSON.stringify(frame));
    expect(JSON.parse(await received)).toEqual(frame);
    machine.close(1000, 'done');
    client.close(1000, 'done');
  });

  it.each(['revoked', 'stale'] as const)('rejects a %s machine grant before replacing the live socket or accessing blobs', async (reason) => {
    const machine = await openSocket('machine', 'darktop');
    const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
    if (reason === 'revoked') await vault.removeManagedDevice('darktop');
    else await vault.registerDevice(signCredentialAuthorityGrant({ ...machineGrant.grant, generation: 2 }, privateKey));
    const rejected = await exports.default.fetch(machineAuthorizedRequest(
      'https://relay.test/ws?role=machine&id=darktop', { headers: { upgrade: 'websocket' } },
    ));
    expect(rejected.status).toBe(401);
    expect(machine.readyState).toBe(WebSocket.OPEN);
    const hash = 'a'.repeat(64);
    await env.BLOBS.put(`artifacts/${hash}`, 'existing encrypted artifact');
    for (const method of ['GET', 'HEAD', 'PUT']) {
      const response = await exports.default.fetch(machineAuthorizedRequest(`https://relay.test/artifacts/${hash}`, { method }));
      expect(response.status).toBe(401);
    }
    machine.close(1000, 'done');
  });

  it('fails closed when current authority is unreachable and no usable registry is cached', async () => {
    interruptAuthority();
    const connect = await exports.default.fetch(machineAuthorizedRequest(
      'https://relay.test/ws?role=machine&id=darktop', { headers: { upgrade: 'websocket' } },
    ));
    expect(connect.status).toBe(503);
    expect(await connect.json()).toMatchObject({ error: { code: 'DEVICE_AUTHORITY_UNAVAILABLE', message: 'Device authority is unavailable; retry shortly' } });
    const artifact = await exports.default.fetch(machineAuthorizedRequest(`https://relay.test/artifacts/${'b'.repeat(64)}`));
    expect(artifact.status).toBe(503);
  });

  describe('managed (self-signed) machine grants', () => {
    const managedKey = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
    const publicKey = (key: Uint8Array) => credentialProtocolBase64.encode(ed25519.getPublicKey(key));
    async function registerManaged() {
      const registered = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).registerManagedDevice({
        userId: env.ACCOUNT_ID, machineId: 'managed-a', signingPublicKey: publicKey(managedKey), exchangePublicKey: publicKey(managedKey), capabilities: ['storage.access', 'space.control'],
      });
      if (registered.status !== 'ok') throw new Error(registered.error.message);
      return signCredentialAuthorityGrant({ version: 1, userId: env.ACCOUNT_ID, machineId: 'managed-a', signingPublicKey: publicKey(managedKey), exchangePublicKey: publicKey(managedKey), capabilities: ['storage.access', 'space.control'], generation: registered.value.generation }, managedKey);
    }
    const attempt = (machineId: string, key: Uint8Array, grant: SignedCredentialAuthorityGrant) => Promise.all([
      exports.default.fetch(machineAuthorizedRequest(`https://relay.test/ws?role=machine&id=${machineId}`, { headers: { upgrade: 'websocket' } }, key, grant)),
      exports.default.fetch(machineAuthorizedRequest(`https://relay.test/artifacts/${'c'.repeat(64)}`, { method: 'HEAD' }, key, grant)),
    ]);

    it('accepts the current managed device on both machine sockets and machine requests', async () => {
      const [socket, artifact] = await attempt('managed-a', managedKey, await registerManaged());
      expect(socket.status).toBe(101);
      socket.webSocket?.accept();
      expect(artifact.status).toBe(404);
      socket.webSocket?.close(1000, 'done');
    });

    it('rejects a forged self-signed grant for an existing managed machine with a different key', async () => {
      const genuine = await registerManaged();
      const forgedKey = Uint8Array.from({ length: 32 }, (_, index) => 7 + index);
      const forged = signCredentialAuthorityGrant({ ...genuine.grant, signingPublicKey: publicKey(forgedKey) }, forgedKey);
      const [socket, artifact] = await attempt('managed-a', forgedKey, forged);
      expect(socket.status).toBe(401);
      expect(artifact.status).toBe(401);
    });

    it('rejects a self-signed grant for a root-paired device even with its own key', async () => {
      const selfSigned = signCredentialAuthorityGrant(machineGrant.grant, machinePrivateKey);
      const [socket, artifact] = await attempt('darktop', machinePrivateKey, selfSigned);
      expect(socket.status).toBe(401);
      expect(artifact.status).toBe(401);
    });

    it('rejects a revoked managed device', async () => {
      const grant = await registerManaged();
      await env.CREDENTIALS.getByName(env.ACCOUNT_ID).removeManagedDevice('managed-a');
      const [socket, artifact] = await attempt('managed-a', managedKey, grant);
      expect(socket.status).toBe(401);
      expect(artifact.status).toBe(401);
    });
  });

  it('rechecks authority before sending a new tunnel to an already connected revoked machine', async () => {
    const machine = await openSocket('machine', 'darktop');
    const messages: unknown[] = [];
    machine.addEventListener('message', (event) => messages.push(event.data));
    const closed = new Promise<CloseEvent>((resolve) => machine.addEventListener('close', resolve, { once: true }));
    await env.CREDENTIALS.getByName(env.ACCOUNT_ID).removeManagedDevice('darktop');
    const response = await exports.default.fetch(authorizedRequest('https://relay.test/tunnel/darktop/private'));
    expect(response.status).toBe(503);
    expect((await closed).code).toBe(1008);
    expect(messages).toEqual([]);
  });

  it.each(['machine', 'client'] as const)('blocks %s frames once the machine authority lease expires', async (sender) => {
    const machine = await openSocket('machine', 'darktop');
    const client = await openSocket('client', 'browser');
    const messages: unknown[] = [];
    (sender === 'machine' ? client : machine).addEventListener('message', (event) => messages.push(event.data));
    const closed = new Promise<CloseEvent>((resolve) => machine.addEventListener('close', resolve, { once: true }));
    await env.CREDENTIALS.getByName(env.ACCOUNT_ID).removeManagedDevice('darktop');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001);
    (sender === 'machine' ? machine : client).send(JSON.stringify({
      version: RELAY_PROTOCOL_VERSION,
      type: 'frame',
      to: sender === 'machine' ? 'client:browser' : 'machine:darktop',
      payload: 'must-not-be-delivered',
    }));
    expect((await closed).code).toBe(1008);
    expect(messages).toEqual([]);
    client.close(1000, 'done');
  });

  it.each(['revoked', 'unreachable'] as const)('closes an idle socket on its alarm once its authority is %s', async (reason) => {
    const machine = await openSocket('machine', 'darktop');
    const closed = new Promise<CloseEvent>((resolve) => machine.addEventListener('close', resolve, { once: true }));
    if (reason === 'revoked') await env.CREDENTIALS.getByName(env.ACCOUNT_ID).removeManagedDevice('darktop');
    else interruptAuthority();
    // An unreachable vault is tolerated until the cached registry is two minutes old.
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + (reason === 'revoked' ? 30_001 : 120_001));
    expect(await runDurableObjectAlarm(env.RELAY.getByName(env.RELAY_NAME))).toBe(true);
    expect((await closed).code).toBe(1008);
  });

  it('keeps legacy machine recovery transport alive after inference cutover', async () => {
    const machine = await openSocket('machine', 'darktop');
    await env.CREDENTIALS.getByName(env.ACCOUNT_ID).ensureInference();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001);
    expect(await runDurableObjectAlarm(env.RELAY.getByName(env.RELAY_NAME))).toBe(true);
    const frame = { version: RELAY_PROTOCOL_VERSION, type: 'frame', to: 'machine:darktop', payload: 'recover' };
    const echoed = nextMessage(machine);
    machine.send(JSON.stringify(frame));
    expect(JSON.parse(await echoed)).toEqual(frame);
    machine.close(1000, 'done');
  });

  it('echoes the v1 frame previous-release machines use for liveness and expires a silent one with a CORS error', async () => {
    const machine = await openSocket('machine', 'darktop', true);
    const frame = { version: RELAY_PROTOCOL_VERSION, type: 'frame', to: 'machine:darktop', payload: crypto.randomUUID() };
    const echoed = nextMessage(machine);
    machine.send(JSON.stringify(frame));
    expect(JSON.parse(await echoed)).toEqual(frame);
    const received = nextMessage(machine);
    const responsePromise = exports.default.fetch(authorizedRequest('https://relay.test/tunnel/darktop/rpc', {
      method: 'POST',
      headers: { origin: `https://${env.RELAY_NAME}.gitspace.sh` },
    }));
    expect(parseTunnelRequest(await received).type).toBe('tunnel.request.start');
    const closed = new Promise<CloseEvent>((resolve) => machine.addEventListener('close', resolve, { once: true }));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + RELAY_HEARTBEAT_LEASE_MS + 1);
    expect(await runDurableObjectAlarm(env.RELAY.getByName(env.RELAY_NAME))).toBe(true);
    expect((await closed).code).toBe(1011);
    const response = await responsePromise;
    expect(response.status).toBe(502);
    expect(response.headers.get('access-control-allow-origin')).toBe(`https://${env.RELAY_NAME}.gitspace.sh`);
    expect(await response.json()).toMatchObject({ error: { code: 'TUNNEL_TRANSPORT_FAILED' } });
  });

  it('leaves a machine that sends no pings connected past the heartbeat lease', async () => {
    const clock = vi.spyOn(Date, 'now');
    const start = Date.now();
    const legacy = await openSocket('machine', 'darktop');
    clock.mockReturnValue(start + 100_000);
    await runDurableObjectAlarm(env.RELAY.getByName(env.RELAY_NAME));
    expect(legacy.readyState).toBe(WebSocket.OPEN);
    legacy.close(1000, 'done');
  });

  it('fails an old in-flight request on replacement without replaying it or failing the new socket request', async () => {
    const old = await openSocket('machine', 'darktop');
    let oldServer: WebSocket | undefined;
    await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (_instance, state) => {
      oldServer = state.getWebSockets('endpoint:machine:darktop')[0];
    });
    const oldReceived = nextMessage(old);
    const oldResponse = exports.default.fetch(authorizedRequest('https://relay.test/tunnel/darktop/rpc', { method: 'POST' }));
    const oldRequest = parseTunnelRequest(await oldReceived);
    const replacement = await openSocket('machine', 'darktop');
    expect((await oldResponse).status).toBe(502);
    const received: TunnelRequestMessage[] = [];
    const newStarted = Promise.withResolvers<string>();
    replacement.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = parseTunnelRequest(event.data);
      received.push(message);
      if (message.type === 'tunnel.request.start') newStarted.resolve(message.requestId);
    });
    const newResponse = exports.default.fetch(authorizedRequest('https://relay.test/tunnel/darktop/health'));
    const requestId = await newStarted.promise;
    await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (instance) => {
      // An unclean, delayed close must neither echo reserved code 1006 nor poison the replacement.
      await instance.webSocketClose(oldServer!, 1006, 'Connection ended');
    });
    replacement.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.start', requestId, status: 204, headers: [] }));
    replacement.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.end', requestId }));
    expect((await newResponse).status).toBe(204);
    expect(received.some((message) => message.requestId === oldRequest.requestId)).toBe(false);
    replacement.close(1000, 'done');
  });

  it('turns a synchronous socket send failure into a CORS transport response', async () => {
    const machine = await openSocket('machine', 'darktop');
    await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (_instance, state) => {
      const socket = state.getWebSockets('endpoint:machine:darktop')[0]!;
      vi.spyOn(socket, 'send').mockImplementation(() => { throw new Error('Transport send failed'); });
    });
    const response = await exports.default.fetch(authorizedRequest('https://relay.test/tunnel/darktop/rpc', {
      method: 'POST',
      headers: { origin: `https://${env.RELAY_NAME}.gitspace.sh` },
    }));
    expect(response.status).toBe(502);
    expect(response.headers.get('access-control-allow-origin')).toBe(`https://${env.RELAY_NAME}.gitspace.sh`);
    expect(await response.json()).toMatchObject({ error: { code: 'TUNNEL_TRANSPORT_FAILED' } });
    machine.close(1000, 'done');
  });

  it('releases a cancelled downstream response and asks the machine to abort only that request', async () => {
    const machine = await openSocket('machine', 'darktop', true);
    const cancelled = Promise.withResolvers<string>();
    let requestId = '';
    machine.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = parseTunnelRequest(event.data);
      if (message.type === 'tunnel.request.end') {
        requestId = message.requestId;
        machine.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.start', requestId, status: 200, headers: [] }));
      } else if (message.type === 'tunnel.request.cancel') {
        cancelled.resolve(message.requestId);
      }
    });
    const response = await exports.default.fetch(authorizedRequest('https://relay.test/tunnel/darktop/events'));
    await response.body!.cancel();
    expect(await cancelled.promise).toBe(requestId);
    expect(machine.readyState).toBe(WebSocket.OPEN);
    machine.close(1000, 'done');
  });

  it('streams a signed 33 MiB upload through the real relay without a buffered DO RPC body', async () => {
    const machine = await openSocket('machine', 'darktop');
    const device = await enrollServiceBrowser();
    const size = 33 * 1024 * 1024, chunk = new Uint8Array(64 * 1024).fill(37);
    const expected = createHash('sha256');
    for (let offset = 0; offset < size; offset += chunk.byteLength) expected.update(chunk);
    const bodySha256 = expected.digest('base64'), received = createHash('sha256');
    let produced = 0, bytes = 0, streaming = false;
    machine.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      const message = parseTunnelRequest(event.data);
      if (message.type === 'tunnel.request.chunk') {
        if (bytes === 0) streaming = produced < size;
        const part = decodeTunnelChunk(message.data); bytes += part.byteLength; received.update(part);
      } else if (message.type === 'tunnel.request.end') {
        machine.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.start', requestId: message.requestId, status: 200, headers: [] }));
        machine.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.chunk', requestId: message.requestId, data: encodeTunnelChunk(new TextEncoder().encode(JSON.stringify({ bytes, digest: received.digest('base64') }))) }));
        machine.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.end', requestId: message.requestId }));
      }
    });
    const path = '/tunnel/darktop/upload';
    const body = new ReadableStream<Uint8Array>({ pull(controller) { produced += chunk.byteLength; controller.enqueue(chunk); if (produced === size) controller.close(); } }, { highWaterMark: 0 });
    // The shared fixture uses a 2s header deadline; this throughput proof has its own 30s test deadline.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const response = await relayWorker.fetch(new Request(`https://relay.test${path}`, { method: 'PUT', headers: { 'content-length': String(size), 'x-gitspace-device': signRpcDigestRequest({ ...device, method: 'PUT', path, bodySha256 }) }, body }), env);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ bytes: size, digest: bodySha256 });
      expect(streaming).toBe(true);
    } finally { vi.useRealTimers(); machine.close(1000, 'done'); }
  }, 30_000);

  it.each(['digest', 'length'] as const)('cancels a signed upload with a mismatched %s without sending normal EOF', async mismatch => {
    const machine = await openSocket('machine', 'darktop', true);
    const device = await enrollServiceBrowser();
    const chunk = new Uint8Array(64 * 1024).fill(37);
    const bodySha256 = createHash('sha256').update(mismatch === 'digest' ? new Uint8Array(chunk.byteLength) : chunk).digest('base64');
    let ended = false, cancelled = false;
    machine.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      const message = parseTunnelRequest(event.data);
      if (message.type === 'tunnel.request.cancel') cancelled = true;
      if (message.type === 'tunnel.request.end') {
        ended = true;
        machine.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.start', requestId: message.requestId, status: 200, headers: [] }));
        machine.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'tunnel.response.end', requestId: message.requestId }));
      }
    });
    const path = '/tunnel/darktop/upload';
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk); controller.close(); } });
    try {
      const response = await relayWorker.fetch(new Request(`https://relay.test${path}`, { method: 'PUT', headers: { 'content-length': String(chunk.byteLength + (mismatch === 'length' ? 1 : 0)), 'x-gitspace-device': signRpcDigestRequest({ ...device, method: 'PUT', path, bodySha256 }) }, body }), env);
      expect(response.status).toBe(502);
      expect(ended).toBe(false);
      await vi.waitFor(() => expect(cancelled).toBe(true));
    } finally { machine.close(1000, 'done'); }
  });

  it('streams a development HTTP request through the machine socket', async () => {
    const machine = await openSocket('machine', 'darktop');
    const bodyParts: Uint8Array[] = [];
    let requestId = '';
    let startMessage: Extract<TunnelRequestMessage, { type: 'tunnel.request.start' }> | undefined;

    machine.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = parseTunnelRequest(event.data);
      requestId = message.requestId;
      if (message.type === 'tunnel.request.start') {
        startMessage = message;
      } else if (message.type === 'tunnel.request.chunk') {
        bodyParts.push(decodeTunnelChunk(message.data));
      } else if (message.type === 'tunnel.request.end') {
        machine.send(JSON.stringify({
          version: RELAY_PROTOCOL_VERSION,
          type: 'tunnel.response.start',
          requestId,
          status: 201,
          headers: [['content-type', 'text/plain'], ['x-local-service', 'yes']],
        }));
        machine.send(JSON.stringify({
          version: RELAY_PROTOCOL_VERSION,
          type: 'tunnel.response.chunk',
          requestId,
          data: encodeTunnelChunk(new TextEncoder().encode('local response')),
        }));
        machine.send(JSON.stringify({
          version: RELAY_PROTOCOL_VERSION,
          type: 'tunnel.response.end',
          requestId,
        }));
      }
    });

    const response = await exports.default.fetch(authorizedRequest(
      'https://relay.test/tunnel/darktop/api/hello?mode=dev',
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-request-test': 'kept', 'x-gitspace-signed-target': '/forged', 'x-gitspace-role': 'machine', 'x-gitspace-endpoint-id': 'forged', 'x-gitspace-tunnel-machine': 'other-machine', 'x-gitspace-tunnel-path': '/forged', 'x-gitspace-service-session': 'forged', 'x-forwarded-host': 'forged.gssh.dev', 'x-gitspace-service-assertion': 'forged' },
        body: 'request body',
      },
    ));

    expect(response.status).toBe(201);
    expect(response.headers.get('x-local-service')).toBe('yes');
    expect(await response.text()).toBe('local response');
    expect(startMessage).toMatchObject({ method: 'POST', path: '/api/hello?mode=dev' });
    expect(startMessage?.headers).toContainEqual(['x-request-test', 'kept']);
    expect(new Headers(startMessage?.headers).get('x-gitspace-signed-target')).toBe('/tunnel/darktop/api/hello?mode=dev');
    for (const name of ['x-gitspace-role', 'x-gitspace-endpoint-id', 'x-gitspace-tunnel-machine', 'x-gitspace-tunnel-path', 'x-gitspace-service-session', 'x-forwarded-host', 'x-gitspace-service-assertion']) expect(new Headers(startMessage?.headers).has(name)).toBe(false);
    const requestBody = new Uint8Array(bodyParts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of bodyParts) {
      requestBody.set(part, offset);
      offset += part.byteLength;
    }
    expect(new TextDecoder().decode(requestBody)).toBe('request body');
    machine.close(1000, 'done');
  });
  it('stores client-sealed artifact bytes by their content address', async () => {
    // The route stores what the client sealed, opaque to the account.
    const sealed = crypto.getRandomValues(new Uint8Array(96));
    const hash = await ciphertextHash(sealed);
    const path = `/artifacts/${hash}`;

    const put = await exports.default.fetch(machineAuthorizedRequest(`https://relay.test${path}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/vnd.gitspace.encrypted',
        'content-length': String(sealed.byteLength),
        'x-gitspace-encryption': 'aes-256-gcm-v1',
      },
      body: Uint8Array.from(sealed),
    }));
    expect(put.status).toBe(201);

    const stored = await env.BLOBS.get(`artifacts/${hash}`);
    if (!stored) throw new Error('Expected the sealed artifact in R2');
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(sealed);

    const get = await exports.default.fetch(machineAuthorizedRequest(`https://relay.test${path}`));
    expect(get.headers.get('x-gitspace-encryption')).toBe('aes-256-gcm-v1');
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(sealed);
  });

  it('serves host-cookie HTTP, cloud internal fetch, and authenticated second-machine access through signed relay ingress', async () => {
    const hostname = `web--space-a--${env.TENANT_ID}-srv.gssh.dev`;
    await env.HOSTED_ROUTES.getByName(hostname).lease(env.ACCOUNT_ID, 'project-a', { hostname, workspaceId: 'space-a', serviceName: 'web', source: 'declared', machineId: 'darktop', ingress: 'http://127.0.0.1:3000', portName: 'http', port: 3000, generation: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'healthy', updatedAt: new Date().toISOString() }, 'darktop');
    const trust = await env.ACCOUNT_STATE.getByName(env.ACCOUNT_ID).browserTrust();
    const machine = await openSocket('machine', 'darktop');
    const observed: string[] = [];
    let cloudHeaders: Headers | undefined;
    machine.addEventListener('message', event => {
      const message = parseTunnelRequest(String(event.data));
      if (message.type !== 'tunnel.request.start') return;
      const assertion = verifyServiceAssertion({ header: new Headers(message.headers).get(SERVICE_ASSERTION_HEADER), publicKey: trust.publicKey, accountId: env.ACCOUNT_ID, machineId: 'darktop', hostname, method: message.method, target: message.path });
      if (!assertion) throw new Error('Worker did not sign service request');
      observed.push(assertion.caller.kind === 'device' ? assertion.caller.deviceId : assertion.caller.workspaceId);
      if (message.path === '/cloud') cloudHeaders = new Headers(message.headers);
      machine.send(JSON.stringify({ version: 1, type: 'tunnel.response.start', requestId: message.requestId, status: 200, headers: [] }));
      machine.send(JSON.stringify({ version: 1, type: 'tunnel.response.chunk', requestId: message.requestId, data: encodeTunnelChunk(new TextEncoder().encode('private service')) }));
      machine.send(JSON.stringify({ version: 1, type: 'tunnel.response.end', requestId: message.requestId }));
    });
    const relay = env.RELAY.getByName(env.RELAY_NAME);
    const state = crypto.randomUUID();
    const { deviceId: browserId } = await enrollServiceBrowser();
    const ticket = await relay.serviceApprove({ hostname, deviceId: browserId, state, returnTo: '/' });
    const session = await relay.serviceRedeem(ticket, hostname, state);
    if (!session) throw new Error('Ticket failed');
    const cookieResponse = await exports.default.fetch(new Request(`https://${hostname}/private?x=1`, { headers: { cookie: `__Host-gitspace-service=${session.token}` } }));
    expect(await cookieResponse.text()).toBe('private service');
    const cloudResponse = await fetchInternalService(env, { kind: 'cloud', accountId: env.ACCOUNT_ID, projectId: 'project-a', workspaceId: 'space-a' }, new Request(`https://${hostname}/cloud`, { headers: { cookie: 'app_session=logged-in; __Host-gitspace-service=private; __Host-gitspace-service-state=state', authorization: 'Bearer app-token' } }));
    expect(await cloudResponse.text()).toBe('private service');
    expect(cloudHeaders?.get('cookie')).toBe('app_session=logged-in');
    expect(cloudHeaders?.get('authorization')).toBe('Bearer app-token');
    const keyB = Uint8Array.from({ length: 32 }, (_, index) => index + 50);
    await env.CREDENTIALS.getByName(env.ACCOUNT_ID).registerDevice(signCredentialAuthorityGrant({ ...machineGrant.grant, machineId: 'machine-b', signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(keyB)) }, privateKey));
    const path = `/api/services/fetch?url=${encodeURIComponent(`https://${hostname}/from-b`)}`;
    const responseB = await exports.default.fetch(new Request(`https://relay.test${path}`, { headers: { 'x-gitspace-machine': 'machine-b', authorization: createRelayAuthorization(keyB, `GET\n${path}`) } }));
    expect(await responseB.text()).toBe('private service');
    expect(observed).toEqual([browserId, 'space-a', 'machine-b']);
    const forged = await exports.default.fetch(new Request('https://relay.test/tunnel/darktop/private', { headers: { 'x-forwarded-host': hostname } }));
    expect(forged.status).toBe(401);
    machine.close();
  });

  it.each(['expiry', 'revocation', 'logout'] as const)('closes cookie-authenticated service WebSocket on %s after a successful roundtrip', async reason => {
    const hostname = `socket--space-a--${env.TENANT_ID}-srv.gssh.dev`;
    await env.HOSTED_ROUTES.getByName(hostname).lease(env.ACCOUNT_ID, 'project-a', { hostname, workspaceId: 'space-a', serviceName: 'socket', source: 'declared', machineId: 'darktop', ingress: 'http://127.0.0.1:3001', portName: 'http', port: 3001, generation: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'healthy', updatedAt: new Date().toISOString() }, 'darktop');
    const machine = await openSocket('machine', 'darktop');
    machine.addEventListener('message', event => {
      const message = parseTunnelRequest(String(event.data));
      if (message.type === 'tunnel.request.start') {
        expect(new Headers(message.headers).get('upgrade')).toBe('websocket');
        machine.send(JSON.stringify({ version: 1, type: 'tunnel.websocket.open', requestId: message.requestId }));
      } else if (message.type === 'tunnel.websocket.data') machine.send(JSON.stringify({ ...message, data: `echo:${message.data}` }));
    });
    const relay = env.RELAY.getByName(env.RELAY_NAME);
    const state = crypto.randomUUID();
    const { deviceId: browserId } = await enrollServiceBrowser();
    const ticket = await relay.serviceApprove({ hostname, deviceId: browserId, state, returnTo: '/' });
    const session = await relay.serviceRedeem(ticket, hostname, state);
    if (!session) throw new Error('Ticket failed');
    const response = await exports.default.fetch(new Request(`https://${hostname}/socket`, { headers: { origin: `https://${hostname}`, upgrade: 'websocket', cookie: `__Host-gitspace-service=${session.token}` } }));
    expect(response.status).toBe(101);
    const client = response.webSocket;
    if (!client) throw new Error('Missing service WebSocket');
    client.accept();
    const echoed = nextMessage(client);
    client.send('hello');
    expect(await echoed).toBe('echo:hello');
    const closed = new Promise<CloseEvent>(resolve => client.addEventListener('close', resolve, { once: true }));
    if (reason === 'revocation') await env.CREDENTIALS.getByName(env.ACCOUNT_ID).revokeDeviceGrant(browserId);
    else if (reason === 'logout') await exports.default.fetch(new Request(`https://${hostname}/__gitspace/logout`, { method: 'POST', headers: { origin: `https://${hostname}`, cookie: `__Host-gitspace-service=${session.token}` } }));
    else {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 900_001);
      await runDurableObjectAlarm(relay);
    }
    expect((await closed).code).toBe(1008);
    expect(await relay.serviceValidate(session.token, hostname)).toBeNull();
    machine.close();
  });

  /** A machine serving `routes` (hostname, workspace): plain requests answer `private service`, WebSockets echo. */
  async function cloudServiceMachine(routes: ReadonlyArray<readonly [string, string]>) {
    for (const [name, workspaceId] of routes) await env.HOSTED_ROUTES.getByName(name).lease(env.ACCOUNT_ID, 'project-a', { hostname: name, workspaceId, serviceName: 'socket', source: 'declared', machineId: 'darktop', ingress: 'http://127.0.0.1:3001', portName: 'http', port: 3001, generation: 1, leaseExpiresAt: new Date(Date.now() + 3_600_000).toISOString(), health: 'healthy', updatedAt: new Date().toISOString() }, 'darktop');
    const trust = await env.ACCOUNT_STATE.getByName(env.ACCOUNT_ID).browserTrust();
    const machine = await openSocket('machine', 'darktop');
    const callers: unknown[] = [];
    machine.addEventListener('message', event => {
      const message = parseTunnelRequest(String(event.data));
      if (message.type === 'tunnel.request.start') {
        const headers = new Headers(message.headers);
        callers.push(verifyServiceAssertion({ header: headers.get(SERVICE_ASSERTION_HEADER), publicKey: trust.publicKey, accountId: env.ACCOUNT_ID, machineId: 'darktop', hostname: headers.get('x-forwarded-host') ?? '', method: message.method, target: message.path })?.caller);
        if (headers.get('upgrade') === 'websocket') { machine.send(JSON.stringify({ version: 1, type: 'tunnel.websocket.open', requestId: message.requestId })); return; }
        machine.send(JSON.stringify({ version: 1, type: 'tunnel.response.start', requestId: message.requestId, status: 200, headers: [] }));
        machine.send(JSON.stringify({ version: 1, type: 'tunnel.response.chunk', requestId: message.requestId, data: encodeTunnelChunk(new TextEncoder().encode('private service')) }));
        machine.send(JSON.stringify({ version: 1, type: 'tunnel.response.end', requestId: message.requestId }));
      } else if (message.type === 'tunnel.websocket.data') machine.send(JSON.stringify({ ...message, data: `echo:${message.data}` }));
    });
    return { machine, callers };
  }
  async function openServiceSocket(hostname: string, cookie: string): Promise<WebSocket> {
    const response = await exports.default.fetch(new Request(`https://${hostname}/socket`, { headers: { origin: `https://${hostname}`, upgrade: 'websocket', cookie } }));
    expect(response.status).toBe(101);
    const client = response.webSocket;
    if (!client) throw new Error('Missing service WebSocket');
    client.accept();
    const echoed = nextMessage(client);
    client.send('hello');
    expect(await echoed).toBe('echo:hello');
    return client;
  }

  it('admits a cloud browser session on its own workspace hostname over HTTP and WebSocket, and on no other', async () => {
    const hostname = `socket--space-a--${env.TENANT_ID}-srv.gssh.dev`, elsewhere = `socket--space-b--${env.TENANT_ID}-srv.gssh.dev`;
    const { machine, callers } = await cloudServiceMachine([[hostname, 'space-a'], [elsewhere, 'space-b']]);
    const relay = env.RELAY.getByName(env.RELAY_NAME);
    const workspace = { projectId: 'project-a', workspaceId: 'space-a' };
    const session = await relay.serviceCloudSession(hostname, workspace);
    // Minting again renews the same session, so WebSockets open on it stay open.
    expect((await relay.serviceCloudSession(hostname, workspace)).token).toBe(session.token);
    const cookie = `__Host-gitspace-service=${session.token}`;
    expect(await (await exports.default.fetch(new Request(`https://${hostname}/app`, { headers: { cookie } }))).text()).toBe('private service');
    const client = await openServiceSocket(hostname, cookie);
    expect(callers).toEqual([{ kind: 'cloud', accountId: env.ACCOUNT_ID, ...workspace }, { kind: 'cloud', accountId: env.ACCOUNT_ID, ...workspace }]);
    expect(await runInDurableObject(relay, instance => instance.serviceCloudSession(elsewhere, workspace).then(() => 'minted', () => 'refused'))).toBe('refused');
    const foreignSocket = await exports.default.fetch(new Request(`https://${elsewhere}/socket`, { headers: { origin: `https://${elsewhere}`, upgrade: 'websocket', cookie } }));
    expect(foreignSocket.status).toBe(401);
    expect((await exports.default.fetch(new Request(`https://${elsewhere}/app`, { headers: { cookie }, redirect: 'manual' }))).status).toBe(303);
    expect(callers).toHaveLength(2);
    client.close();
    machine.close();
  });

  it.each(['expiry', 'the workspace retiring'] as const)('ends a cloud browser session and its WebSocket on %s', async reason => {
    const hostname = `socket--space-a--${env.TENANT_ID}-srv.gssh.dev`;
    const { machine } = await cloudServiceMachine([[hostname, 'space-a']]);
    const relay = env.RELAY.getByName(env.RELAY_NAME);
    const session = await relay.serviceCloudSession(hostname, { projectId: 'project-a', workspaceId: 'space-a' });
    const cookie = `__Host-gitspace-service=${session.token}`;
    const client = await openServiceSocket(hostname, cookie);
    const closed = Promise.withResolvers<CloseEvent>();
    client.addEventListener('close', closed.resolve, { once: true });
    if (reason === 'the workspace retiring') await relay.browserRelayRetireWorkspace('project-a', 'space-a');
    else {
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 900_001);
      // Expired is refused at once, before the alarm removes it.
      expect((await exports.default.fetch(new Request(`https://${hostname}/app`, { headers: { cookie }, redirect: 'manual' }))).status).toBe(303);
      await runDurableObjectAlarm(relay);
    }
    expect((await closed.promise).code).toBe(1008);
    // The cookie no longer admits: the browser is sent to sign in as any browser without a session is.
    expect((await exports.default.fetch(new Request(`https://${hostname}/app`, { headers: { cookie }, redirect: 'manual' }))).status).toBe(303);
    machine.close();
  });

  it.each(['the machine closes the service', 'the browser closes', 'the machine disconnects'] as const)('carries a service WebSocket on a hibernatable socket until %s', async ending => {
    const hostname = `socket--space-a--${env.TENANT_ID}-srv.gssh.dev`;
    await env.HOSTED_ROUTES.getByName(hostname).lease(env.ACCOUNT_ID, 'project-a', { hostname, workspaceId: 'space-a', serviceName: 'socket', source: 'declared', machineId: 'darktop', ingress: 'http://127.0.0.1:3001', portName: 'http', port: 3001, generation: 1, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'healthy', updatedAt: new Date().toISOString() }, 'darktop');
    const machine = await openSocket('machine', 'darktop');
    const forwarded = Promise.withResolvers<TunnelRequestMessage>();
    const machineClosed = Promise.withResolvers<TunnelRequestMessage>();
    machine.addEventListener('message', event => {
      const message = parseTunnelRequest(String(event.data));
      if (message.type === 'tunnel.request.start') machine.send(JSON.stringify({ version: 1, type: 'tunnel.websocket.open', requestId: message.requestId }));
      if (message.type === 'tunnel.websocket.data') forwarded.resolve(message);
      if (message.type === 'tunnel.websocket.close') machineClosed.resolve(message);
    });
    const relay = env.RELAY.getByName(env.RELAY_NAME);
    const state = crypto.randomUUID();
    const { deviceId: browserId } = await enrollServiceBrowser();
    const session = await relay.serviceRedeem(await relay.serviceApprove({ hostname, deviceId: browserId, state, returnTo: '/' }), hostname, state);
    if (!session) throw new Error('Ticket failed');
    const response = await exports.default.fetch(new Request(`https://${hostname}/socket`, { headers: { origin: `https://${hostname}`, upgrade: 'websocket', cookie: `__Host-gitspace-service=${session.token}` } }));
    const client = response.webSocket;
    if (!client) throw new Error('Missing service WebSocket');
    client.accept();
    const clientClosed = new Promise<CloseEvent>(resolve => client.addEventListener('close', resolve, { once: true }));
    const requestId = await runInDurableObject(relay, async (_instance, objectState) => {
      const [service] = objectState.getWebSockets('service');
      if (!service) throw new Error('The service WebSocket is not hibernatable');
      const attachment = z.object({ role: z.literal('service'), requestId: z.string(), machineId: z.string() }).parse(service.deserializeAttachment());
      expect(attachment.machineId).toBe('darktop');
      // A relay object with no memory, as after hibernation, still routes the browser's frame to the machine.
      await new UserRelayDO(objectState, env).webSocketMessage(service, 'after-wake');
      return attachment.requestId;
    });
    expect(await forwarded.promise).toMatchObject({ type: 'tunnel.websocket.data', requestId, data: 'after-wake', binary: false });
    if (ending === 'the machine closes the service') {
      machine.send(JSON.stringify({ version: 1, type: 'tunnel.websocket.close', requestId, code: 1000, reason: 'service done' }));
      expect(await clientClosed).toMatchObject({ code: 1000, reason: 'service done' });
    } else if (ending === 'the browser closes') {
      client.close(1000, 'tab closed');
      expect(await machineClosed.promise).toMatchObject({ type: 'tunnel.websocket.close', requestId });
    } else {
      machine.close(1000, 'host stopped');
      expect((await clientClosed).code).toBe(1011);
      return;
    }
    machine.close();
  });
});
