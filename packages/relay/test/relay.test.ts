import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  RELAY_PROTOCOL_VERSION,
  createRelayAuthorization,
  decodeTunnelChunk,
  decryptArtifactBytes,
  encodeTunnelChunk,
  encryptArtifactBytes,
  tunnelRequestMessageSchema,
  type TunnelRequestMessage,
} from '@gitspace/protocol';

const privateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

function authorizedRequest(url: string, init: RequestInit = {}): Request {
  const parsed = new URL(url);
  const target = `${parsed.pathname}${parsed.search}`;
  const headers = new Headers(init.headers);
  headers.set('authorization', createRelayAuthorization(privateKey, target));
  return new Request(url, { ...init, headers });
}

async function openSocket(role: 'machine' | 'client', id: string): Promise<WebSocket> {
  const response = await exports.default.fetch(authorizedRequest(
    `https://relay.test/ws?role=${role}&id=${id}`,
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
      privateKey,
      target,
      Date.now(),
      '12345678-1234-4234-8234-123456789abc',
    );
    const init = { headers: { upgrade: 'websocket', authorization: header } };
    const accepted = await exports.default.fetch(new Request(url, init));
    expect(accepted.status).toBe(101);
    accepted.webSocket?.accept();
    const replay = await exports.default.fetch(new Request(url, init));
    expect(replay.status).toBe(401);
    accepted.webSocket?.close(1000, 'done');
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

    const put = await exports.default.fetch(authorizedRequest(`https://relay.test${path}`, {
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

    const get = await exports.default.fetch(authorizedRequest(`https://relay.test${path}`));
    expect(get.status).toBe(200);
    expect(get.headers.get('x-gitspace-encryption')).toBe('aes-256-gcm-v1');
    expect(await decryptArtifactBytes(new Uint8Array(await get.arrayBuffer()), key)).toEqual(plaintext);
  });

});
