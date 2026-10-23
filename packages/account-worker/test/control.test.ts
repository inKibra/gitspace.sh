import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  CONTROL_SOCKET_PROTOCOL,
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
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

describe('signed control transport', () => {
  it('stores signed release objects in the dedicated R2 binding', async () => {
    const userId = env.ACCOUNT_ID;
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
    const key = 'releases/release-a/frontend/index.html';
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
    expect((await env.DATA.head(`users/${userId}/${key}`))?.customMetadata?.sha256).toBe(hash);

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
  });
  it('serves a release object only under the hash it was recorded with', async () => {
    const userId = env.ACCOUNT_ID;
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)) });
    await vault.registerDevice(signCredentialAuthorityGrant({ version: 1, userId, machineId: 'machine-a', signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineSigningPrivateKey)), exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(machineExchangePrivateKey)), capabilities: ['storage.access'], generation: 1 }, rootPrivateKey));
    const bytes = new TextEncoder().encode('release file');
    const hash = await sha256(bytes);
    const download = (key: string, named: string) => SELF.fetch(`https://auth.test/v1/data/${key}`, { headers: { 'x-gitspace-control': signedHeader(createSignedControlRequest({ userId, machineId: 'machine-a', operation: 'data.get', payload: { key, hash: named }, signingPrivateKey: machineSigningPrivateKey })) } });
    const recorded = 'releases/release-a/recorded.bin';
    await env.DATA.put(`users/${userId}/${recorded}`, bytes, { customMetadata: { sha256: hash } });
    const served = await download(recorded, hash);
    expect([served.status, served.headers.get('x-gitspace-sha256')]).toEqual([200, hash]);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
    expect((await download(recorded, `sha256:${'0'.repeat(64)}`)).status).toBe(409);
  });
  it('rejects oversized signed objects after authorization and preserves upload validation and immutability', async () => {
    const userId = env.ACCOUNT_ID;
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
    const key = 'releases/release-a/machine.bin';
    const bytes = new Uint8Array([1]);
    const hash = await sha256(bytes);
    const maxBytes = 64 * 1024 * 1024;
    const oversized = { key, hash, size: maxBytes + 1 };
    const upload = (payload: Record<string, unknown>, signingPrivateKey = machineSigningPrivateKey) => SELF.fetch(`https://auth.test/v1/data/${key}`, {
      method: 'PUT',
      headers: {
        'content-length': String(bytes.byteLength),
        'x-gitspace-control': signedHeader(createSignedControlRequest({
          userId, machineId: 'machine-a', operation: 'data.put', payload, signingPrivateKey,
        })),
      },
      body: bytes,
    });
    expect((await upload(oversized, machineBSigningPrivateKey)).status).toBe(401);
    const rejected = await upload(oversized);
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toMatchObject({
      status: 'error', error: { code: 'OBJECT_TOO_LARGE', size: maxBytes + 1, maxBytes },
    });
    expect(await env.DATA.head(`users/${userId}/${key}`)).toBeNull();
    const metadata = await upload({ key, hash: 'invalid', size: 1 });
    expect(metadata.status).toBe(400);
    expect(await metadata.json()).toMatchObject({ error: { code: 'INVALID_OBJECT_METADATA' } });
    const length = await upload({ key, hash, size: 2 });
    expect(length.status).toBe(400);
    expect(await length.json()).toMatchObject({ error: { code: 'OBJECT_BODY_LENGTH_MISMATCH', size: 2, declaredSize: 1 } });
    // The cap is inclusive: a legal signed size proceeds to body-length validation.
    const boundary = await upload({ key, hash, size: maxBytes });
    expect(boundary.status).toBe(400);
    expect(await boundary.json()).toMatchObject({ error: { code: 'OBJECT_BODY_LENGTH_MISMATCH' } });
    const mismatch = await upload({ key, hash: await sha256(new Uint8Array([2])), size: 1 });
    expect(mismatch.status).toBe(400);
    expect(await env.DATA.head(`users/${userId}/${key}`)).toBeNull();
    expect((await upload({ key, hash, size: 1 })).status).toBe(201);
    expect((await upload({ key, hash, size: 1 })).status).toBe(204);
    const conflict = await upload({ key, hash: await sha256(new Uint8Array([2])), size: 1 });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'OBJECT_CONFLICT' } });
    const stored = await env.DATA.get(`users/${userId}/${key}`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(bytes);
  });
  it('pushes settings generations to every authenticated machine subscriber', async () => {
    const userId = env.ACCOUNT_ID;
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
      const protocol = `${CONTROL_SOCKET_PROTOCOL}${signedHeader(subscription)}`;
      const response = await SELF.fetch('https://auth.test/v1/settings/events', { headers: { upgrade: 'websocket', 'sec-websocket-protocol': protocol } });
      expect(response.status).toBe(101);
      expect(response.headers.get('sec-websocket-protocol')).toBe(protocol);
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
    // A proof in the URL is not authentication.
    const inUrl = createSignedControlRequest({ userId, machineId: 'machine-a', operation: 'settings.subscribe', payload: {}, signingPrivateKey: machineSigningPrivateKey });
    expect((await SELF.fetch(`https://auth.test/v1/settings/events?control=${signedHeader(inUrl)}`, { headers: { upgrade: 'websocket' } })).status).toBe(400);
    // Machines re-apply the account Git author whenever the account edits user settings.
    const settings = env.USER_SETTINGS.getByName(userId);
    const { revision, updatedAt: _updatedAt, updatedBy: _updatedBy, version: _version, ...current } = await settings.get('browser');
    const pushedA = nextMessage(socketA);
    const pushedB = nextMessage(socketB);
    expect(await settings.update('browser', { ...current, expectedRevision: revision, git: { authorName: 'Ada', authorEmail: 'ada@example.com' } })).toMatchObject({ status: 'ok' });
    expect(await pushedA).toMatchObject({ type: 'settings.changed', userRevision: revision + 1 });
    expect(await pushedB).toMatchObject({ type: 'settings.changed', userRevision: revision + 1 });
    socketA.close(1000, 'done');
    socketB.close(1000, 'done');
  });
  it('authorizes a control-plane managed sandbox device until it is removed', async () => {
    const userId = env.ACCOUNT_ID;
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
    const control = () => SELF.fetch('https://auth.test/v1/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createSignedControlRequest({ userId, machineId, operation: 'settings.get', payload: {}, signingPrivateKey: machineBSigningPrivateKey })),
    });
    expect((await control()).status).toBe(200);
    await vault.removeManagedDevice(machineId);
    const revoked = await control();
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } });
  });
});

describe('signed request windows', () => {
  const minutes = 60_000;
  async function enroll() {
    const userId = env.ACCOUNT_ID;
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
    return { userId, vault };
  }
  async function signedUpload(userId: string, key: string, signedAgoMs: number) {
    const bytes = new TextEncoder().encode(`checkpoint:${key}`);
    const request = createSignedControlRequest({
      userId,
      machineId: 'machine-a',
      operation: 'data.put',
      payload: { key, hash: await sha256(bytes), size: bytes.byteLength },
      signingPrivateKey: machineSigningPrivateKey,
      timestamp: Date.now() - signedAgoMs,
    });
    return () => SELF.fetch(`https://auth.test/v1/data/${key}`, {
      method: 'PUT',
      headers: { 'content-length': String(bytes.byteLength), 'x-gitspace-control': signedHeader(request) },
      body: bytes,
    });
  }

  it('accepts a data.put whose body arrives long after signing, up to the upload window', async () => {
    const { userId } = await enroll();
    expect((await (await signedUpload(userId, 'releases/p/buffered.bin', 10 * minutes))()).status).toBe(201);
    const expired = await (await signedUpload(userId, 'releases/p/expired.bin', 31 * minutes))();
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({ status: 'error', error: { code: 'REQUEST_EXPIRED', message: 'Signed request expired' } });
    expect(await env.DATA.head(`users/${userId}/releases/p/expired.bin`)).toBeNull();
  });

  it('keeps the upload window to data.put and accepts other requests only within 60 seconds of the account clock', async () => {
    const { userId } = await enroll();
    const signed = (offsetMs: number, user = userId) => createSignedControlRequest({
      userId: user, machineId: 'machine-a', operation: 'settings.get', payload: {},
      signingPrivateKey: machineSigningPrivateKey, timestamp: Date.now() + offsetMs,
    });
    const control = (offsetMs: number, user = userId) => SELF.fetch('https://auth.test/v1/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signed(offsetMs, user)),
    });
    expect((await control(-50_000)).status).toBe(200);
    expect((await control(50_000)).status).toBe(200);
    for (const offset of [-90_000, 90_000]) {
      const expired = await control(offset);
      expect(expired.status).toBe(401);
      expect(await expired.json()).toMatchObject({ error: { code: 'REQUEST_EXPIRED', message: 'Signed request expired' } });
    }
    // A validly signed proof for another account is invalid, not merely late.
    expect(await (await control(-90_000, 'another-user')).json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    const read = createSignedControlRequest({
      userId, machineId: 'machine-a', operation: 'data.head', payload: { key: 'releases/p/missing.bin', hash: await sha256(new Uint8Array([1])) },
      signingPrivateKey: machineSigningPrivateKey, timestamp: Date.now() - 90_000,
    });
    const staleRead = await SELF.fetch('https://auth.test/v1/data/releases/p/missing.bin', { method: 'HEAD', headers: { 'x-gitspace-control': signedHeader(read) } });
    expect(staleRead.status).toBe(401);
  });
});
