import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  createSignedControlRequest,
  credentialProtocolBase64,
  signCredentialAuthorityGrant,
} from '@gitspace/protocol';

const rootPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const machineSigningPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const machineExchangePrivateKey = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);
const machineBSigningPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 80);
const machineBExchangePrivateKey = Uint8Array.from({ length: 32 }, (_, index) => 150 - index);

function signedHeader(request: ReturnType<typeof createSignedControlRequest>): string {
  return btoa(JSON.stringify(request)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function sha256(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

describe('signed control transport', () => {
  it('routes a replay-protected device-signed request to the canonical space authority', async () => {
    const userId = `user-control-${crypto.randomUUID()}`;
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({
      userId,
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)),
      vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)),
    });
    await vault.registerDevice(signCredentialAuthorityGrant({
      version: 1,
      userId,
      machineId: 'machine-a',
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineSigningPrivateKey)),
      exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(machineExchangePrivateKey)),
      capabilities: ['space.control'],
      generation: 1,
    }, rootPrivateKey));
    const request = createSignedControlRequest({
      userId,
      machineId: 'machine-a',
      operation: 'space.bootstrap',
      payload: { projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-a' },
      signingPrivateKey: machineSigningPrivateKey,
    });
    const response = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', value: { projectId: 'project-a', spaceId: 'space-a', state: 'open', generation: 1 } });
    const inspector = createSignedControlRequest({
      userId,
      machineId: 'machine-a',
      operation: 'inspector.getOverview',
      payload: { projectId: 'project-a', spaceId: 'space-a' },
      signingPrivateKey: machineSigningPrivateKey,
    });
    const inspectorResponse = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(inspector),
    });
    expect(inspectorResponse.status).toBe(200);
    expect(await inspectorResponse.json()).toMatchObject({
      status: 'ok',
      value: { projectId: 'project-a', spaceId: 'space-a', revision: 0, goal: null },
    });
    const createCron = createSignedControlRequest({
      userId,
      machineId: 'machine-a',
      operation: 'crons.create',
      payload: {
        projectId: 'project-a',
        draft: {
          name: 'authority-health',
          schedule: 'every 5m',
          description: 'Exercise the signed project cron authority route.',
          prompt: 'Check the canonical project agent health.',
          target: { scope: 'project', projectId: 'project-a' },
          readScopes: ['repository/**'],
          writeScopes: [],
          enabled: true,
        },
      },
      signingPrivateKey: machineSigningPrivateKey,
    });
    const cronResponse = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createCron),
    });
    expect(cronResponse.status).toBe(200);
    expect(await cronResponse.json()).toMatchObject({
      status: 'ok',
      value: { projectId: 'project-a', name: 'authority-health', revision: 1 },
    });
    const replay = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(replay.status).toBe(401);
  });
  it('stores signed application data in the dedicated R2 binding', async () => {
    const userId = `user-data-${crypto.randomUUID()}`;
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({
      userId,
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)),
      vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)),
    });
    await vault.registerDevice(signCredentialAuthorityGrant({
      version: 1,
      userId,
      machineId: 'machine-a',
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineSigningPrivateKey)),
      exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(machineExchangePrivateKey)),
      capabilities: ['storage.access'],
      generation: 1,
    }, rootPrivateKey));
    const bytes = new TextEncoder().encode('portable-agent-state');
    const hash = await sha256(bytes);
    const key = 'projects/project-a/spaces/space-a/session.bin';
    const put = createSignedControlRequest({
      userId,
      machineId: 'machine-a',
      operation: 'data.put',
      payload: { key, hash, size: bytes.byteLength },
      signingPrivateKey: machineSigningPrivateKey,
    });
    const uploaded = await SELF.fetch(`https://auth.test/v1/data/${key}`, {
      method: 'PUT',
      headers: {
        'content-length': String(bytes.byteLength),
        'content-type': 'application/octet-stream',
        'x-gitspace-control': signedHeader(put),
      },
      body: bytes,
    });
    expect(uploaded.status).toBe(201);
    expect((await env.DATA.head(`users/${userId}/${key}`))?.customMetadata.sha256).toBe(hash);

    const get = createSignedControlRequest({
      userId,
      machineId: 'machine-a',
      operation: 'data.get',
      payload: { key, hash },
      signingPrivateKey: machineSigningPrivateKey,
    });
    const downloaded = await SELF.fetch(`https://auth.test/v1/data/${key}`, {
      headers: { 'x-gitspace-control': signedHeader(get) },
    });
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);

    const replay = await SELF.fetch(`https://auth.test/v1/data/${key}`, {
      headers: { 'x-gitspace-control': signedHeader(get) },
    });
    expect(replay.status).toBe(401);
  });
  it('authorizes canonical settings writes and reports stale generations', async () => {
    const userId = `user-settings-${crypto.randomUUID()}`;
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({
      userId,
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)),
      vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)),
    });
    await vault.registerDevice(signCredentialAuthorityGrant({
      version: 1,
      userId,
      machineId: 'machine-a',
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineSigningPrivateKey)),
      exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(machineExchangePrivateKey)),
      capabilities: ['storage.access'],
      generation: 1,
    }, rootPrivateKey));
    const content = 'cycleOrder:\n  - default\n';
    const hash = await sha256(new TextEncoder().encode(content));
    const update = (expectedGeneration: number) => createSignedControlRequest({
      userId,
      machineId: 'machine-a',
      operation: 'settings.omp.update',
      payload: { expectedGeneration, content, checksum: hash },
      signingPrivateKey: machineSigningPrivateKey,
    });
    const stored = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update(0)),
    });
    expect(stored.status).toBe(200);
    expect(await stored.json()).toMatchObject({ status: 'ok', value: { generation: 1, content, checksum: hash } });
    const stale = await SELF.fetch('https://auth.test/v1/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(update(0)),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ status: 'error', error: { code: 'SETTINGS_CONFLICT', resource: 'omp-config', expected: 0, actual: 1 } });
  });
  it('pushes settings generations to every authenticated machine subscriber', async () => {
    const userId = `user-settings-stream-${crypto.randomUUID()}`;
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({
      userId,
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)),
      vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)),
    });
    for (const [machineId, signingKey, exchangeKey] of [
      ['machine-a', machineSigningPrivateKey, machineExchangePrivateKey],
      ['machine-b', machineBSigningPrivateKey, machineBExchangePrivateKey],
    ] as const) {
      await vault.registerDevice(signCredentialAuthorityGrant({
        version: 1,
        userId,
        machineId,
        signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingKey)),
        exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(exchangeKey)),
        capabilities: ['storage.access'],
        generation: 1,
      }, rootPrivateKey));
    }
    const openSubscription = async (machineId: string, signingKey: Uint8Array): Promise<WebSocket> => {
      const subscription = createSignedControlRequest({ userId, machineId, operation: 'settings.subscribe', payload: {}, signingPrivateKey: signingKey });
      const response = await SELF.fetch(`https://auth.test/v1/settings/events?control=${encodeURIComponent(signedHeader(subscription))}`, { headers: { upgrade: 'websocket' } });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept();
      return socket;
    };
    const nextMessage = (socket: WebSocket) => new Promise<Record<string, unknown>>((resolve) => {
      socket.addEventListener('message', (event) => resolve(JSON.parse(String(event.data)) as Record<string, unknown>), { once: true });
    });
    const [socketA, socketB] = await Promise.all([
      openSubscription('machine-a', machineSigningPrivateKey),
      openSubscription('machine-b', machineBSigningPrivateKey),
    ]);
    const content = 'cycleOrder:\n  - slow\n';
    const update = createSignedControlRequest({
      userId,
      machineId: 'machine-a',
      operation: 'settings.omp.update',
      payload: { expectedGeneration: 0, content, checksum: await sha256(new TextEncoder().encode(content)) },
      signingPrivateKey: machineSigningPrivateKey,
    });
    const pushedA = nextMessage(socketA);
    const pushedB = nextMessage(socketB);
    const stored = await SELF.fetch('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(update) });
    expect(stored.status).toBe(200);
    expect(await pushedA).toMatchObject({ type: 'settings.changed', ompGeneration: 1 });
    expect(await pushedB).toMatchObject({ type: 'settings.changed', ompGeneration: 1 });
    socketA.close(1000, 'done');
    socketB.close(1000, 'done');
  });
  it('authorizes a control-plane managed sandbox device', async () => {
    const userId = `managed-sandbox-${crypto.randomUUID()}`;
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({
      userId,
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)),
      vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)),
    });
    const machineId = 'sandbox-managed-a';
    expect(await vault.registerManagedDevice({
      userId,
      machineId,
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineBSigningPrivateKey)),
      exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(machineBExchangePrivateKey)),
      capabilities: ['storage.access', 'space.control'],
    })).toMatchObject({ status: 'ok', value: { machineId, generation: 1 } });
    const request = createSignedControlRequest({ userId, machineId, operation: 'settings.get', payload: {}, signingPrivateKey: machineBSigningPrivateKey });
    expect(await vault.authorizeControl(request, 'storage.access')).toEqual({ status: 'ok', value: { authorized: true } });
    await vault.removeManagedDevice(machineId);
    const revokedRequest = createSignedControlRequest({ userId, machineId, operation: 'settings.get', payload: {}, signingPrivateKey: machineBSigningPrivateKey });
    expect(await vault.authorizeControl(revokedRequest, 'storage.access')).toMatchObject({ status: 'error' });
  });
});
