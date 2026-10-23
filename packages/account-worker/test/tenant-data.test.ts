import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createHash } from 'node:crypto';
import { artifactObjectKey, createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant, TENANT_OBJECT_PART_BYTES, type ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachInputSchema } from '@gitspace/protocol-runtime';
import { GitLfsObjectSchema } from '@gitspace/protocol-workspace';
import { AttachmentStore, type AttachmentServices } from '@gitspace/runtime-workspace-do';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { gitLfsObjectKey } from '../src/git-lfs-store.js';
import { tenantObjectKey, tenantStore } from '../src/tenant-store.js';
import { tenantRootPrivateKey } from './setup.js';

const signingPrivateKey = new Uint8Array(32).fill(61);
const projectId = 'data-project';
const workspaceId = 'data-workspace';
const services: AttachmentServices = {
  seal: async () => 'test-sealed-execution-secret',
  open: async () => { throw new Error('This fixture does not recover execution secrets'); },
  dispatch: async () => { throw new Error('Data requests must not dispatch tools'); },
};

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function fixture() {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  for (const machineId of ['attached', 'unattached']) {
    await vault.registerDevice(signCredentialAuthorityGrant({
      version: 1, userId, machineId, generation: 1, capabilities: ['storage.access'],
      signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingPrivateKey)),
      exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(62))),
    }, tenantRootPrivateKey));
  }
  const project = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const created = await project.bootstrap({ id: projectId, name: 'Data', repositoryReference: null, baseBranch: 'main', createdBy: 'attached' });
  await project.setProjectLifecycle(created.revision, 'active');
  for (const id of [workspaceId, 'sibling-workspace']) {
    await project.putWorkspace({ id, projectId, kind: 'worktree', name: id, branch: 'main', phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  }
  const space = env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`);
  await space.runtimeSnapshot({ projectId, workspaceId });
  await runInDurableObject(space, async (_instance, state) => {
    await new AttachmentStore(state.storage, services).attach(RuntimeAttachInputSchema.parse({ projectId, workspaceId, machineId: 'attached', generation: 1, checkout: { kind: 'shared', branch: 'main' }, capabilities: [] }), true);
  });
  const send = (method: string, operation: ControlOperation, key: string, payload: Record<string, unknown>, body?: Uint8Array<ArrayBuffer>, machineId = 'attached') => {
    const signed = createSignedControlRequest({ userId, machineId, operation, payload: { key, ...payload }, signingPrivateKey });
    return SELF.fetch(`https://auth.test/v1/data/${key.split('/').map(encodeURIComponent).join('/')}`, {
      method,
      headers: { 'x-gitspace-control': btoa(JSON.stringify(signed)), ...(body ? { 'content-length': String(body.byteLength) } : {}) },
      ...(body ? { body } : {}),
    });
  };
  const pin = (bytes: Uint8Array) => {
    const object = GitLfsObjectSchema.parse({ oid: sha256(bytes).slice(7), size: bytes.byteLength });
    return project.lfsPin({ publicationId: 'attached:capture', objects: [object] }).then(() => gitLfsObjectKey(projectId, object.oid));
  };
  return { userId, send, pin };
}

describe('tenant data endpoint', () => {
  it('carries plaintext both ways bound to its digest, and refuses names outside the tenant namespaces', async () => {
    const { userId, send, pin } = await fixture();
    const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 241);
    const name = await pin(bytes);
    expect((await send('PUT', 'data.put', name, { hash: sha256(bytes), size: bytes.byteLength }, bytes)).status).toBe(201);
    expect((await env.DATA.head(tenantObjectKey(userId, name)))?.customMetadata).toEqual({ scope: `lfs:${projectId}`, sha256: sha256(bytes), size: String(bytes.byteLength) });
    expect(await env.DATA.head(`users/${userId}/${name}`)).toBeNull();
    const head = await send('HEAD', 'data.head', name, { hash: sha256(bytes) });
    expect([head.status, head.headers.get('x-gitspace-sha256'), head.headers.get('x-gitspace-size')]).toEqual([200, sha256(bytes), String(bytes.byteLength)]);
    const get = await send('GET', 'data.get', name, {});
    expect(get.headers.get('x-gitspace-sha256')).toBe(sha256(bytes));
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);
    const named = await send('GET', 'data.get', name, { hash: sha256(new Uint8Array([1])) });
    expect([named.status, await named.json()]).toMatchObject([409, { error: { code: 'HASH_MISMATCH' } }]);
    expect((await send('PUT', 'data.put', name, { hash: sha256(bytes), size: bytes.byteLength }, bytes)).status).toBe(204);
    // Bytes that miss the signed digest are never stored.
    const declared = Uint8Array.from(bytes, byte => byte ^ 1);
    const other = await pin(declared);
    expect((await send('PUT', 'data.put', other, { hash: sha256(declared), size: bytes.byteLength }, bytes)).ok).toBe(false);
    expect((await send('HEAD', 'data.head', other, {})).status).toBe(404);
    for (const refused of [
      'notes/plain.txt',
      `accounts/${Buffer.from(userId).toString('base64url')}/artifacts/sha256/${sha256(bytes).slice(7)}`,
      `${name}.chunks/${'c'.repeat(64)}`,
    ]) {
      const response = await send('GET', 'data.get', refused, {});
      expect([response.status, await response.json()]).toMatchObject([400, { error: { code: 'OBJECT_NAMESPACE_REFUSED' } }]);
    }
  });

  it('uploads an object above one request as uniform parts, refusing a part that misses its digest', async () => {
    const { send, pin } = await fixture();
    const bytes = Uint8Array.from({ length: TENANT_OBJECT_PART_BYTES + 1024 * 1024 + 3 }, (_, index) => (index * 7) % 253);
    const name = await pin(bytes);
    const whole = await send('PUT', 'data.put', name, { hash: sha256(bytes), size: bytes.byteLength }, bytes);
    expect([whole.status, await whole.json()]).toMatchObject([413, { error: { code: 'OBJECT_TOO_LARGE' } }]);
    const created = await send('POST', 'data.multipart.create', name, { hash: sha256(bytes), size: bytes.byteLength });
    const upload = z.object({ value: z.object({ uploadId: z.string(), partBytes: z.number() }) }).parse(await created.json()).value;
    expect(upload.partBytes).toBe(TENANT_OBJECT_PART_BYTES);
    const part = async (partNumber: number, body: Uint8Array<ArrayBuffer>, hash = sha256(body)) => send('PUT', 'data.multipart.part', name, { uploadId: upload.uploadId, partNumber, hash, size: body.byteLength }, body);
    const first = bytes.subarray(0, TENANT_OBJECT_PART_BYTES);
    const last = bytes.subarray(TENANT_OBJECT_PART_BYTES);
    const uploaded = z.object({ value: z.object({ partNumber: z.number(), etag: z.string() }) });
    const parts = [uploaded.parse(await (await part(1, first)).json()).value];
    const corrupt = await part(2, last, sha256(first));
    expect([corrupt.status, await corrupt.json()]).toMatchObject([409, { error: { code: 'OBJECT_INTEGRITY' } }]);
    parts.push(uploaded.parse(await (await part(2, last)).json()).value);
    const completed = await send('POST', 'data.multipart.complete', name, { uploadId: upload.uploadId, parts });
    expect([completed.status, await completed.json()]).toEqual([201, { status: 'ok', value: { hash: sha256(bytes), size: bytes.byteLength } }]);
    const get = await send('GET', 'data.get', name, { hash: sha256(bytes) });
    expect(get.headers.get('x-gitspace-size')).toBe(String(bytes.byteLength));
    expect(sha256(new Uint8Array(await get.arrayBuffer()))).toBe(sha256(bytes));
  }, 60_000);

  it('lets a machine reach only the drives of the workspace it is attached to', async () => {
    const { userId, send } = await fixture();
    const workspace = { projectId, workspaceId };
    const bytes = new TextEncoder().encode('drive file from a machine');
    const own = artifactObjectKey(userId, `space:${workspaceId}`, sha256(bytes));
    const write = { ...workspace, hash: sha256(bytes), size: bytes.byteLength };
    expect((await send('PUT', 'data.put', own, write, bytes, 'unattached')).status).toBe(403);
    expect((await send('PUT', 'data.put', own, { hash: sha256(bytes), size: bytes.byteLength }, bytes)).status).toBe(400);
    expect((await send('PUT', 'data.put', own, write, bytes)).status).toBe(201);
    expect(new Uint8Array(await (await send('GET', 'data.get', own, workspace)).arrayBuffer())).toEqual(bytes);
    // The project's base drive is readable from its worktree, never writable; a sibling's drive is neither.
    const base = new TextEncoder().encode('project drive file');
    const baseName = artifactObjectKey(userId, `space:${projectId}`, sha256(base));
    await tenantStore(env).put(baseName, `space:${projectId}`, base);
    expect(new Uint8Array(await (await send('GET', 'data.get', baseName, workspace)).arrayBuffer())).toEqual(base);
    expect((await send('PUT', 'data.put', artifactObjectKey(userId, `space:${projectId}`, sha256(bytes)), write, bytes)).status).toBe(403);
    const sibling = artifactObjectKey(userId, 'space:sibling-workspace', sha256(base));
    await tenantStore(env).put(sibling, 'space:sibling-workspace', base);
    expect((await send('GET', 'data.get', sibling, workspace)).status).toBe(403);
  });
});
