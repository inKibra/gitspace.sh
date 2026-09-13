import { ed25519 } from '@noble/curves/ed25519.js';
import { env, exports } from 'cloudflare:workers';
import { runInDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RELAY_HEARTBEAT_LEASE_MS,
  RELAY_HEARTBEAT_MODE,
  RELAY_PROTOCOL_VERSION,
  createRelayAuthorization,
  decodeTunnelChunk,
  decryptArtifactBytes,
  encodeTunnelChunk,
  encryptArtifactBytes,
  tunnelRequestMessageSchema,
  type TunnelRequestMessage,
} from '@gitspace/protocol';
import {
  credentialProtocolBase64,
  signCredentialAuthorityGrant,
  type SignedCredentialAuthorityGrant,
} from '@gitspace/protocol/credential-vault';
import relayWorker, { CredentialVaultDO } from '../src/index.js';

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

function interruptAuthority() {
  vi.spyOn(CredentialVaultDO.prototype, 'authorizeRelayGrant').mockRejectedValue(new Error('Authority unavailable'));
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
function machineAuthorizedRequest(url: string, init: RequestInit = {}): Request {
  const parsed = new URL(url);
  const target = `${parsed.pathname}${parsed.search}`;
  const headers = new Headers(init.headers);
  headers.set('authorization', createRelayAuthorization(machinePrivateKey, target));
  headers.set('x-gitspace-machine-grant', btoa(JSON.stringify(machineGrant)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, ''));
  return new Request(url, { ...init, headers });
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
  const digest = await crypto.subtle.digest('SHA-256', bytes);
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

  it('rejects reuse of one signed authorization nonce', async () => {
    const url = 'https://relay.test/ws?role=machine&id=darktop';
    const target = '/ws?role=machine&id=darktop';
    const header = createRelayAuthorization(
      machinePrivateKey,
      target,
      Date.now(),
      '12345678-1234-4234-8234-123456789abc',
    );
    const grant = btoa(JSON.stringify(machineGrant)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    const init = { headers: { upgrade: 'websocket', authorization: header, 'x-gitspace-machine-grant': grant } };
    const accepted = await exports.default.fetch(new Request(url, init));
    expect(accepted.status).toBe(101);
    accepted.webSocket?.accept();
    const replay = await exports.default.fetch(new Request(url, init));
    expect(replay.status).toBe(401);
    accepted.webSocket?.close(1000, 'done');
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

  it('fails closed when current authority is unreachable', async () => {
    interruptAuthority();
    const connect = await exports.default.fetch(machineAuthorizedRequest(
      'https://relay.test/ws?role=machine&id=darktop', { headers: { upgrade: 'websocket' } },
    ));
    expect(connect.status).toBe(503);
    const artifact = await exports.default.fetch(machineAuthorizedRequest(`https://relay.test/artifacts/${'b'.repeat(64)}`));
    expect(artifact.status).toBe(503);
  });

  it('rechecks authority before sending a new tunnel to an already connected revoked machine', async () => {
    const machine = await openSocket('machine', 'darktop');
    const messages: unknown[] = [];
    machine.addEventListener('message', (event) => messages.push(event.data));
    const closed = new Promise<CloseEvent>((resolve) => machine.addEventListener('close', resolve, { once: true }));
    await env.CREDENTIALS.getByName(env.ACCOUNT_ID).removeManagedDevice('darktop');
    const response = await exports.default.fetch(new Request('https://relay.test/tunnel/darktop/private'));
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

  it.each(['revoked', 'unreachable'] as const)('closes an idle socket with %s authority when its durable lease expires', async (reason) => {
    const machine = await openSocket('machine', 'darktop');
    const closed = new Promise<CloseEvent>((resolve) => machine.addEventListener('close', resolve, { once: true }));
    if (reason === 'revoked') await env.CREDENTIALS.getByName(env.ACCOUNT_ID).removeManagedDevice('darktop');
    else interruptAuthority();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_001);
    expect(await runDurableObjectAlarm(env.RELAY.getByName(env.RELAY_NAME))).toBe(true);
    expect((await closed).code).toBe(1008);
  });

  it('echoes the existing v1 frame and expires a silent heartbeat-enabled tunnel with a CORS error', async () => {
    const machine = await openSocket('machine', 'darktop', true);
    const frame = { version: RELAY_PROTOCOL_VERSION, type: 'frame', to: 'machine:darktop', payload: crypto.randomUUID() };
    const echoed = nextMessage(machine);
    machine.send(JSON.stringify(frame));
    expect(JSON.parse(await echoed)).toEqual(frame);
    const received = nextMessage(machine);
    const responsePromise = exports.default.fetch(new Request('https://relay.test/tunnel/darktop/rpc', {
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

  it('keeps renewed heartbeat leases alive and leaves pre-heartbeat hosts compatible', async () => {
    const machine = await openSocket('machine', 'darktop', true);
    const clock = vi.spyOn(Date, 'now');
    const start = Date.now();
    for (const elapsed of [20_000, 40_000]) {
      clock.mockReturnValue(start + elapsed);
      const echoed = nextMessage(machine);
      machine.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, type: 'frame', to: 'machine:darktop', payload: crypto.randomUUID() }));
      await echoed;
      await runDurableObjectAlarm(env.RELAY.getByName(env.RELAY_NAME));
      expect(machine.readyState).toBe(WebSocket.OPEN);
    }
    machine.close(1000, 'done');
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
    const oldResponse = exports.default.fetch(new Request('https://relay.test/tunnel/darktop/rpc', { method: 'POST' }));
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
    const newResponse = exports.default.fetch(new Request('https://relay.test/tunnel/darktop/health'));
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

  it('returns a bounded header timeout and cancels the partial machine request rather than replaying it', async () => {
    const machine = await openSocket('machine', 'darktop', true);
    const cancelled = Promise.withResolvers<TunnelRequestMessage>();
    const uploadCancelled = Promise.withResolvers<void>();
    machine.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const message = parseTunnelRequest(event.data);
      if (message.type === 'tunnel.request.cancel') cancelled.resolve(message);
    });
    // Invoke the HTTP handler directly so cancellation is observable on the incoming
    // upload, rather than hidden behind an additional test service-binding boundary.
    const response = await relayWorker.fetch(new Request('https://relay.test/tunnel/darktop/rpc', {
      method: 'POST',
      headers: { origin: `https://${env.RELAY_NAME}.gitspace.sh` },
      body: new ReadableStream<Uint8Array>({ cancel: () => uploadCancelled.resolve() }),
    }), env);
    expect(response.status).toBe(504);
    expect(response.headers.get('access-control-allow-origin')).toBe(`https://${env.RELAY_NAME}.gitspace.sh`);
    expect(await response.json()).toMatchObject({ error: { code: 'TUNNEL_TIMEOUT' } });
    expect((await cancelled.promise).type).toBe('tunnel.request.cancel');
    await uploadCancelled.promise;
    machine.close(1000, 'done');
  });

  it('turns a synchronous socket send failure into a CORS transport response', async () => {
    const machine = await openSocket('machine', 'darktop');
    await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (_instance, state) => {
      const socket = state.getWebSockets('endpoint:machine:darktop')[0]!;
      vi.spyOn(socket, 'send').mockImplementation(() => { throw new Error('Transport send failed'); });
    });
    const response = await exports.default.fetch(new Request('https://relay.test/tunnel/darktop/rpc', {
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
    const response = await exports.default.fetch(new Request('https://relay.test/tunnel/darktop/events'));
    await response.body!.cancel();
    expect(await cancelled.promise).toBe(requestId);
    expect(machine.readyState).toBe(WebSocket.OPEN);
    machine.close(1000, 'done');
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
        headers: { 'content-type': 'text/plain', 'x-request-test': 'kept' },
        body: 'request body',
      },
    ));

    expect(response.status).toBe(201);
    expect(response.headers.get('x-local-service')).toBe('yes');
    expect(await response.text()).toBe('local response');
    expect(startMessage).toMatchObject({ method: 'POST', path: '/api/hello?mode=dev' });
    expect(startMessage?.headers).toContainEqual(['x-request-test', 'kept']);
    const requestBody = new Uint8Array(bodyParts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of bodyParts) {
      requestBody.set(part, offset);
      offset += part.byteLength;
    }
    expect(new TextDecoder().decode(requestBody)).toBe('request body');
    machine.close(1000, 'done');
  });
  it('stores only client-encrypted content-addressed artifact bytes', async () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
    const plaintextText = 'artifact plaintext must not reach R2';
    const plaintext = new TextEncoder().encode(plaintextText);
    const sealed = await encryptArtifactBytes(plaintext, key);
    const hash = await ciphertextHash(sealed);
    const path = `/artifacts/${hash}`;

    const put = await exports.default.fetch(machineAuthorizedRequest(`https://relay.test${path}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/vnd.gitspace.encrypted',
        'content-length': String(sealed.byteLength),
        'x-gitspace-encryption': 'aes-256-gcm-v1',
      },
      body: sealed,
    }));
    expect(put.status).toBe(201);

    const stored = await env.BLOBS.get(`artifacts/${hash}`);
    if (!stored) throw new Error('Expected encrypted artifact in R2');
    const raw = new Uint8Array(await stored.arrayBuffer());
    expect(new TextDecoder().decode(raw)).not.toContain(plaintextText);
    expect(raw).toEqual(sealed);

    const get = await exports.default.fetch(machineAuthorizedRequest(`https://relay.test${path}`));
    expect(get.headers.get('x-gitspace-encryption')).toBe('aes-256-gcm-v1');
    expect(await decryptArtifactBytes(new Uint8Array(await get.arrayBuffer()), key)).toEqual(plaintext);
  });

});
