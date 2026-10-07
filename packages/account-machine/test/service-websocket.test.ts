import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519.js';
import { GitSpaceDatabase } from '@gitspace/core';
import { credentialProtocolBase64, signCredentialAuthorityGrant, parseRelaySocketMessage, verifyRelayAuthorization } from '@gitspace/protocol';
import { SERVICE_ASSERTION_HEADER, signServiceAssertion } from '@gitspace/protocol/service-access';
import { WorkspaceServiceManager } from '../src/workspace-services.js';
import { MachineRelayConnector } from '../src/relay-connector.js';
import { createServiceAccessClient } from '../src/service-forward.js';

test('real machine connector authenticates service ingress before bridging a local WebSocket', async () => {
  const root = await mkdtemp(join(tmpdir(), 'service-ws-'));
  const database = new GitSpaceDatabase(join(root, 'state.db'));
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const trust = { accountId: 'user-a', publicKey: credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))) };
  const backendHeaders = Promise.withResolvers<Headers>();
  const service = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request, server) { backendHeaders.resolve(request.headers); if (server.upgrade(request)) return; return new Response('upgrade required', { status: 400 }); }, websocket: { message(socket, message) { socket.send(`echo:${message}`); } } });
  const manager = new WorkspaceServiceManager(database, { list: async () => [], startService: async () => { throw new Error('unused'); }, stop: async () => { throw new Error('unused'); } }, 'machine-a', root, 'gssh.dev', 'test', undefined, async () => trust);
  const hostname = 'socket--workspace--test-srv.gssh.dev';
  await manager.registerProcessRoute({ projectId: 'project', workspaceId: 'workspace', generation: 1, name: 'socket', portName: 'http', port: service.port! });
  const ingress = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) { return await manager.proxy(request) ?? new Response(null, { status: 404 }); } });
  const connected = Promise.withResolvers<Bun.ServerWebSocket<undefined>>();
  const echoed = Promise.withResolvers<string>();
  const requestId = crypto.randomUUID();
  const relay = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); }, websocket: {
    open(socket) { connected.resolve(socket); },
    message(socket, data) {
      const parsed = parseRelaySocketMessage(String(data));
      if (parsed.status === 'error') return echoed.reject(parsed.error);
      const message = parsed.value;
      if (message.type === 'tunnel.websocket.open') socket.send(JSON.stringify({ version: 1, type: 'tunnel.websocket.data', requestId, binary: false, data: 'private' }));
      if (message.type === 'tunnel.websocket.data') echoed.resolve(message.data);
      if (message.type === 'tunnel.response.error') echoed.reject(new Error(message.message));
    },
  } });
  const machineKey = new Uint8Array(32).fill(9);
  const grant = signCredentialAuthorityGrant({ version: 1, userId: 'user-a', machineId: 'machine-a', signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineKey)), exchangePublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineKey)), capabilities: ['space.control'], generation: 1 }, machineKey);
  const connector = new MachineRelayConnector({ relayUrl: `http://127.0.0.1:${relay.port}`, machineId: 'machine-a', machineGrant: grant, signingPrivateKey: machineKey, localOrigin: `http://127.0.0.1:${ingress.port}` });
  try {
    connector.start();
    const socket = await connected.promise;
    const assertion = await signServiceAssertion({ version: 1, accountId: 'user-a', machineId: 'machine-a', hostname, caller: { kind: 'device', accountId: 'user-a', deviceId: 'browser' }, method: 'GET', target: '/ws?proof=1', issuedAt: Date.now(), expiresAt: Date.now() + 30_000, nonce: crypto.randomUUID() }, keys.privateKey);
    socket.send(JSON.stringify({ version: 1, type: 'tunnel.request.start', requestId, method: 'GET', path: '/ws?proof=1', headers: [['upgrade', 'websocket'], ['origin', `https://${hostname}`], ['cookie', 'app_session=logged-in; __Host-gitspace-service=private'], ['authorization', 'Bearer app-token'], ['x-forwarded-host', hostname], [SERVICE_ASSERTION_HEADER, assertion]] }));
    socket.send(JSON.stringify({ version: 1, type: 'tunnel.request.end', requestId }));
    expect(await echoed.promise).toBe('echo:private');
    const headers = await backendHeaders.promise;
    expect(headers.get('origin')).toBe(`https://${hostname}`);
    expect(headers.get('cookie')).toBe('app_session=logged-in');
    expect(headers.get('authorization')).toBe('Bearer app-token');
    expect(headers.get(SERVICE_ASSERTION_HEADER)).toBeNull();
  } finally { connector.stop(); await manager.dispose(); await relay.stop(true); await ingress.stop(true); await service.stop(true); database.close(); await rm(root, { recursive: true, force: true }); }
}, 15_000);

test('machine-B loopback WebSocket forwarding signs the relay target and preserves text and binary frames', async () => {
  const signingPrivateKey = new Uint8Array(32).fill(17);
  const signingPublicKey = credentialProtocolBase64.encode(ed25519.getPublicKey(signingPrivateKey));
  const hostname = 'socket--workspace--test-srv.gssh.dev';
  const relay = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request, server) {
    const url = new URL(request.url);
    const authorization = verifyRelayAuthorization({ header: request.headers.get('authorization'), signingPublicKey, target: `${request.method}\n${url.pathname}${url.search}`, maxSkewMs: 30_000 });
    if (authorization.status !== 'ok' || request.headers.get('x-gitspace-machine') !== 'machine-b') return new Response(null, { status: 401 });
    if (url.searchParams.get('url') !== `https://${hostname}/socket?private=1`) return new Response(null, { status: 400 });
    if (request.headers.get('x-gitspace-service-authorization') !== 'Bearer app-token' || request.headers.get('cookie') !== 'app_session=ok') return new Response(null, { status: 403 });
    if (request.headers.has('x-gitspace-forward-token')) return new Response(null, { status: 400 });
    if (server.upgrade(request)) return;
    return new Response(null, { status: 400 });
  }, websocket: { message(socket, data) { socket.send(data); } } });
  const forward = await createServiceAccessClient({ baseUrl: `http://127.0.0.1:${relay.port}`, userId: 'user-a', machineId: 'machine-b', signingPrivateKey }).forward(hostname);
  const socket: unknown = Reflect.construct(WebSocket, [`${forward.url.replace('http:', 'ws:')}/socket?private=1`, { headers: { ...forward.headers, authorization: 'Bearer app-token', cookie: 'app_session=ok' } } satisfies Bun.WebSocketOptions]);
  if (!(socket instanceof WebSocket)) throw new Error('WebSocket construction failed');
  socket.binaryType = 'arraybuffer';
  try {
    expect(new URL(forward.url).hostname).toBe('127.0.0.1');
    await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', reject, { once: true }); });
    const text = new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(event.data), { once: true }));
    socket.send('private text');
    expect(await text).toBe('private text');
    const binary = new Promise<unknown>(resolve => socket.addEventListener('message', event => resolve(event.data), { once: true }));
    socket.send(new Uint8Array([0, 128, 255]));
    const received = await binary;
    if (!(received instanceof ArrayBuffer)) throw new Error('Expected binary frame');
    expect(new Uint8Array(received)).toEqual(new Uint8Array([0, 128, 255]));
  } finally { socket.close(); await forward.close(); await relay.stop(true); }
}, 15_000);
