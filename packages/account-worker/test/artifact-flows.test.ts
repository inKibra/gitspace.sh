import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, deriveArtifactScopeKey, encryptArtifactBytes, signDeviceInvite, type ArtifactManifest } from '@gitspace/protocol';
import { ARTIFACT_UPLOAD_CHUNK_BYTES, gitspaceContract } from '@gitspace/protocol/rpc-contract';
import type { ResourcePreviewFrame } from '@gitspace/protocol/resource-uri';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { createBrowserClient } from 'result-rpc/client';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { ProjectAuthorityDO } from '../src/project-authority.js';
import { tenantRootPrivateKey } from './setup.js';
import { createCipheriv, createHash } from 'node:crypto';
import { CHECKPOINT_CHUNK_BYTES, CHUNKED_CHECKPOINT_VERSION } from '@gitspace/protocol-workspace';
import { readArtifactObject } from '../src/artifact-object-reader.js';
import { InspectorCloudArtifacts, readInspectorContext } from '../src/account-inspector-data.js';

async function fixture() {
  const userId = env.ACCOUNT_ID;
  const handle = env.TENANT_ID;
  const root = tenantRootPrivateKey;
  const deviceKey = crypto.getRandomValues(new Uint8Array(32));
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(root)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  await env.USER_SETTINGS.getByName(userId).setHandle('bootstrap', 0, handle);
  const invite = signDeviceInvite({ version: 1, userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read', 'rpc.write'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://api.gitspace.sh' }, root);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(deviceKey)), label: 'Browser', boundAt: Date.now(), signingPrivateKey: deviceKey });
  const enrolled = await vault.enrollDevice({ invite, binding });
  if (enrolled.status === 'error') throw new Error(enrolled.error.message);
  const projectId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: 'Artifact flows', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  const index = env.USER_PROJECTS.getByName(userId);
  await index.put(await authority.setProjectLifecycle(project.revision, 'active'));
  for (const [id, kind] of [[projectId, 'base'], [workspaceId, 'worktree']] as const) {
    await authority.putWorkspace({ id, projectId, kind, name: kind, branch: 'main', phase: kind === 'base' ? null : 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await index.putWorkspaceLocation(id, projectId);
  }
  const key = credentialProtocolBase64.decode(await vault.artifactKey(userId));
  const store = async (sealed: Uint8Array) => {
    const hash = `sha256:${createHash('sha256').update(sealed).digest('hex')}` as const;
    await env.DATA.put(`users/${userId}/accounts/${Buffer.from(userId).toString('base64url')}/artifacts/sha256/${hash.slice(7)}`, sealed);
    return hash;
  };
  const persist = async (scopeId: string, content: string) => store(await encryptArtifactBytes(new TextEncoder().encode(content), await deriveArtifactScopeKey(key, scopeId)));
  const publish = async (spaceId: string, generation: number, files: Array<{ path: string; content: string; mediaType?: string }>) => {
    const scopeId = `space:${spaceId}`;
    const entries: ArtifactManifest['entries'] = [];
    for (const file of files) entries.push({ path: file.path, blobHash: await persist(scopeId, file.content), size: new TextEncoder().encode(file.content).length, mediaType: file.mediaType ?? 'text/plain' });
    const manifestHash = await persist(scopeId, JSON.stringify({ version: 1, scopeId, generation, entries }));
    await authority.putArtifactScope({ id: scopeId, workspaceId: spaceId, generation, expectedGeneration: generation - 1, manifestHash });
    return entries;
  };
  const publishChunked = async () => {
    const scopeId = `space:${workspaceId}`;
    const scopeKey = await deriveArtifactScopeKey(key, scopeId);
    const expected = createHash('sha256');
    const chunks = [];
    for (const size of [CHECKPOINT_CHUNK_BYTES, 17]) {
      const bytes = new Uint8Array(size).fill(size === 17 ? 2 : 1);
      expected.update(bytes);
      chunks.push({ hash: await store(await encryptArtifactBytes(bytes, scopeKey)), size });
    }
    const size = CHECKPOINT_CHUNK_BYTES + 17;
    const encrypted = await encryptArtifactBytes(new TextEncoder().encode(JSON.stringify({ version: 1, size, chunks })), scopeKey);
    const envelope = new Uint8Array(encrypted.byteLength + 1);
    envelope[0] = CHUNKED_CHECKPOINT_VERSION;
    envelope.set(encrypted, 1);
    const blobHash = await store(envelope);
    const entries = [{ path: 'large.bin', blobHash, size, mediaType: 'application/octet-stream' }];
    const manifestHash = await persist(scopeId, JSON.stringify({ version: 1, scopeId, generation: 1, entries }));
    await authority.putArtifactScope({ id: scopeId, workspaceId, generation: 1, expectedGeneration: 0, manifestHash });
    return { blobHash, size, digest: expected.digest('hex'), finalKey: `users/${userId}/accounts/${Buffer.from(userId).toString('base64url')}/artifacts/sha256/${chunks[1]!.hash.slice(7)}` };
  };
  const publishLegacy = async () => {
    const scopeId = `space:${workspaceId}`;
    const scopeKey = await deriveArtifactScopeKey(key, scopeId);
    // Match the largest retained old envelope without allocating a second full payload.
    const size = 39_479_629;
    const nonce = new Uint8Array(12).fill(7);
    const cipher = createCipheriv('aes-256-gcm', scopeKey, nonce);
    const sealed = new Uint8Array(size + 29);
    sealed[0] = 1;
    sealed.set(nonce, 1);
    const block = Uint8Array.from({ length: 64 * 1024 }, (_, index) => index % 251);
    const expected = createHash('sha256');
    for (let offset = 0; offset < size; offset += block.byteLength) {
      const bytes = block.subarray(0, Math.min(block.byteLength, size - offset));
      expected.update(bytes);
      sealed.set(cipher.update(bytes), 13 + offset);
    }
    sealed.set(cipher.final(), 13 + size);
    sealed.set(cipher.getAuthTag(), 13 + size);
    const blobHash = await store(sealed);
    const entries = [{ path: 'legacy.pcm', blobHash, size, mediaType: 'audio/pcm' }];
    const manifestHash = await persist(scopeId, JSON.stringify({ version: 1, scopeId, generation: 1, entries }));
    const scope = { id: scopeId, workspaceId, generation: 1, manifestHash };
    await authority.putArtifactScope({ ...scope, expectedGeneration: 0 });
    return {
      blobHash, size, scopeKey, scope, digest: expected.digest('hex'),
      objectKey: `users/${userId}/accounts/${Buffer.from(userId).toString('base64url')}/artifacts/sha256/${blobHash.slice(7)}`,
    };
  };
  const origin = `https://${handle}.gitspace.sh`;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return worker.fetch(new Request(input, init), env);
  }) as typeof fetch;
  const client = createBrowserClient({ contract: gitspaceContract, transport: createRoutedTransport({ homeUrl: `${origin}/rpc`, fetch: createSignedRpcFetch({ deviceId: binding.deviceId, userId, signingPrivateKey: deviceKey, fetch: fetcher }) }) });
  const seal = async (scopeId: string, bytes: Uint8Array) => store(await encryptArtifactBytes(bytes, await deriveArtifactScopeKey(key, scopeId)));
  return { client, authority, projectId, workspaceId, publish, publishChunked, publishLegacy, origin, seal };
}

async function readBytes(stream: AsyncIterable<{ status: 'ok'; value: ResourcePreviewFrame } | { status: 'error'; error: unknown }>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const result of stream) {
    if (result.status === 'error') throw result.error;
    if (result.value.type === 'chunk') chunks.push(Buffer.from(result.value.base64, 'base64'));
  }
  return Buffer.concat(chunks);
}

describe('user artifact flows', () => {
  it('previews published resource URLs without a machine or originating session', async () => {
    const { client, workspaceId, projectId, publish } = await fixture();
    await publish(workspaceId, 1, [
      { path: 'notes.txt', content: 'first\nsecond\nthird\n' },
      { path: 'empty.txt', content: '' },
    ]);
    await publish(projectId, 1, [{ path: 'notes.txt', content: 'project notes' }]);
    const request = { spaceId: workspaceId, expectedGeneration: 0, sessionId: null };
    const url = 'drive://notes.txt:raw:2-2';
    const frames = [];
    for await (const frame of client.inspector.resources.read({ ...request, url })) frames.push(frame);
    expect(frames).toEqual([
      { status: 'ok', value: { type: 'metadata', url, mediaType: 'text/plain', text: true, size: 6 } },
      { status: 'ok', value: { type: 'chunk', base64: Buffer.from('second').toString('base64') } },
    ]);
    expect((await readBytes(client.inspector.resources.read({ ...request, sessionId: 'former-session', url: 'drive://base/notes.txt' }))).toString()).toBe('project notes');
    expect((await readBytes(client.inspector.resources.read({ ...request, spaceId: projectId, url: 'drive://notes.txt' }))).toString()).toBe('project notes');
    const empty = [];
    for await (const frame of client.inspector.resources.read({ ...request, url: 'drive://empty.txt' })) empty.push(frame);
    expect(empty).toEqual([{ status: 'ok', value: { type: 'metadata', url: 'drive://empty.txt', mediaType: 'text/plain', text: true, size: 0 } }]);
  });

  it('pages complete cloud resource bytes and rejects cursors from another version or identity', async () => {
    const { client, workspaceId, publish } = await fixture();
    const content = '\0audio'.repeat(25_000);
    await publish(workspaceId, 1, [{ path: 'capture.wav', content, mediaType: 'audio/wav' }]);
    const request = { spaceId: workspaceId, expectedGeneration: 0, sessionId: null, url: 'drive://capture.wav' };
    const first = await client.inspector.resources.readPage({ ...request, cursor: null, limit: 1 });
    if (first.status === 'error') throw first.error;
    expect(first.value.items).toEqual([{ type: 'metadata', url: request.url, mediaType: 'audio/wav', text: false, size: Buffer.byteLength(content) }]);
    expect(first.value.nextCursor).not.toBeNull();
    const chunks: Buffer[] = [];
    let cursor = first.value.nextCursor;
    while (cursor !== null) {
      const page = await client.inspector.resources.readPage({ ...request, cursor, limit: 1 });
      if (page.status === 'error') throw page.error;
      for (const frame of page.value.items) {
        if (frame.type === 'chunk') chunks.push(Buffer.from(frame.base64, 'base64'));
      }
      cursor = page.value.nextCursor;
    }
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(content));
    expect(await readBytes(client.inspector.resources.read(request))).toEqual(Buffer.from(content));
    expect(await client.inspector.resources.readPage({ ...request, sessionId: 'another-session', cursor: first.value.nextCursor, limit: 1 })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/operation-failed' } });
    await publish(workspaceId, 2, [{ path: 'capture.wav', content: 'changed audio', mediaType: 'audio/wav' }]);
    expect(await client.inspector.resources.readPage({ ...request, cursor: first.value.nextCursor, limit: 1 })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/operation-failed' } });
  });

  it('enforces resource scope and placement fences and reports unavailable references', async () => {
    const { client, workspaceId, projectId, authority, publish } = await fixture();
    const siblingId = crypto.randomUUID();
    await authority.putWorkspace({ id: siblingId, projectId, kind: 'worktree', name: 'Sibling', branch: 'main', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await publish(workspaceId, 1, [{ path: 'private.txt', content: 'this workspace' }]);
    await publish(siblingId, 1, [{ path: 'private.txt', content: 'sibling workspace' }]);
    const request = { spaceId: workspaceId, expectedGeneration: 0, sessionId: null };
    const pageRequest = { ...request, cursor: null, limit: 16 };
    for (const url of [
      `drive://workspaces/${siblingId}/private.txt`,
      'drive://workspace/%2e%2e/private.txt',
      'drive://missing.txt',
      'artifact://123',
      'browser-artifact://machine/capture',
    ]) {
      const frames = [];
      for await (const frame of client.inspector.resources.read({ ...request, url })) frames.push(frame);
      expect(frames).toMatchObject([{ status: 'error' }]);
      expect(await client.inspector.resources.readPage({ ...pageRequest, url })).toMatchObject({ status: 'error' });
    }
    expect(await client.inspector.resources.readPage({ ...pageRequest, url: 'artifact://123' })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/inspector-state' } });
    expect(await client.inspector.resources.readPage({ ...pageRequest, expectedGeneration: 1, url: 'drive://private.txt' })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/space-generation-conflict' } });
    expect(await client.inspector.resources.readPage({ ...pageRequest, spaceId: crypto.randomUUID(), url: 'drive://private.txt' })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/workspace-not-found' } });
    expect((await readBytes(client.inspector.resources.read({ ...request, spaceId: projectId, url: `drive://workspaces/${siblingId}/private.txt` }))).toString()).toBe('sibling workspace');
  });

  it('applies the text preview limit before streaming and allows bounded resource selections', async () => {
    const { client, workspaceId, publish } = await fixture();
    await publish(workspaceId, 1, [{ path: 'output.txt', content: `retained line\n${'large output\n'.repeat(20_000)}` }]);
    const request = { spaceId: workspaceId, expectedGeneration: 0, sessionId: null, url: 'drive://output.txt' };
    const frames = [];
    for await (const frame of client.inspector.resources.read(request)) frames.push(frame);
    expect(frames).toMatchObject([{ status: 'error', error: { _tag: 'gitspace/operation-failed' } }]);
    expect(await client.inspector.resources.readPage({ ...request, cursor: null, limit: 16 })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/operation-failed' } });
    expect((await readBytes(client.inspector.resources.read({ ...request, url: `${request.url}:1-1` }))).toString()).toBe('retained line');
  });

  it('keeps oversized previews inside the RPC error contract and reads selected canonical text ranges', async () => {
    const { client, workspaceId, publish } = await fixture();
    await publish(workspaceId, 1, [{ path: 'output.txt', content: `selected line\n${'remaining output\n'.repeat(20_000)}` }]);
    const request = { spaceId: workspaceId, expectedGeneration: 0, hash: null };
    const full = [];
    for await (const frame of client.inspector.artifacts.read({ ...request, url: 'drive://workspace/output.txt' })) full.push(frame);
    expect(full).toMatchObject([{ status: 'error' }]);
    const selected = await readBytes(client.inspector.artifacts.read({ ...request, url: 'drive://workspace/output.txt:raw:1-1' }));
    expect(selected.toString()).toBe('selected line');
  });

  it('streams encrypted published audio beyond a single RPC reply without changing bytes', async () => {
    const { client, workspaceId, publish } = await fixture();
    const content = '\0'.repeat(1024 * 1024 + 17);
    const entries = await publish(workspaceId, 1, [{ path: 'capture.wav', content, mediaType: 'audio/wav' }]);
    const bytes = await readBytes(client.inspector.artifacts.read({ spaceId: workspaceId, expectedGeneration: 0, url: 'drive://workspace/capture.wav', hash: entries[0]!.blobHash }));
    expect(bytes).toEqual(Buffer.from(content));
  });

  it('names a file a machine sealed only when it opens under the workspace scope key', async () => {
    const { client, workspaceId, projectId, seal } = await fixture();
    const artifacts = new InspectorCloudArtifacts(env, env.ACCOUNT_ID, await readInspectorContext(env, env.ACCOUNT_ID, workspaceId, projectId));
    const zip = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 7) % 256);
    const target = await artifacts.machineTarget('drive://workspace/uploads/font.zip');
    expect(target).toEqual({ scopeId: `space:${workspaceId}`, path: 'uploads/font.zip' });
    // Sealed under the project's scope key, the object is refused and nothing is named.
    const foreign = await seal(`space:${projectId}`, zip);
    await expect(artifacts.write('drive://workspace/uploads/font.zip', { sealed: { blobHash: foreign, size: zip.byteLength }, mediaType: 'application/zip' })).rejects.toThrow();
    const sealed = { blobHash: await seal(target.scopeId, zip), size: zip.byteLength };
    await expect(artifacts.write('drive://workspace/uploads/font.zip', { sealed: { ...sealed, size: zip.byteLength + 1 }, mediaType: 'application/zip' })).rejects.toThrow();
    expect((await artifacts.list()).map(entry => entry.path)).toEqual([]);
    const written = await artifacts.write('drive://workspace/uploads/font.zip', { sealed, mediaType: 'application/zip' });
    expect(written).toMatchObject({ url: 'drive://workspace/uploads/font.zip', hash: sealed.blobHash, size: zip.byteLength, mediaType: 'application/zip' });
    expect(await artifacts.locate('drive://workspace/uploads/font.zip')).toEqual({ scopeId: target.scopeId, ...sealed });
    const bytes = await readBytes(client.inspector.artifacts.read({ spaceId: workspaceId, expectedGeneration: 0, url: 'drive://workspace/uploads/font.zip', hash: null }));
    expect(bytes).toEqual(Buffer.from(zip));
  });

  it('records the hash of every drive file it stores, so a machine reader can name it', async () => {
    const { workspaceId, projectId } = await fixture();
    const artifacts = new InspectorCloudArtifacts(env, env.ACCOUNT_ID, await readInspectorContext(env, env.ACCOUNT_ID, workspaceId, projectId));
    const written = await artifacts.write('drive://workspace/notes.txt', { bytes: new TextEncoder().encode('drive notes') });
    const stored = await env.DATA.head(`users/${env.ACCOUNT_ID}/accounts/${Buffer.from(env.ACCOUNT_ID).toString('base64url')}/artifacts/sha256/${written.hash.slice(7)}`);
    expect(stored?.customMetadata?.sha256).toBe(written.hash);
  });

  it('rejects a conflicting batch atomically and keeps re-encrypted project copies independent of later workspace edits', async () => {
    const setup = await fixture();
    const { client, projectId, workspaceId, publish, authority } = setup;
    const source = await publish(workspaceId, 1, [{ path: 'a.txt', content: 'original A' }, { path: 'b.txt', content: 'original B' }]);
    await publish(projectId, 1, [{ path: 'occupied.txt', content: 'keep project content' }]);
    const request = { spaceId: workspaceId, expectedGeneration: 0, expectedProjectGeneration: 1 };
    const files = source.map((entry, index) => ({ url: `drive://workspace/${entry.path}`, hash: entry.blobHash, destinationPath: index === 0 ? 'copied/a.txt' : 'occupied.txt', expectedDestinationHash: null }));
    expect((await client.inspector.artifacts.copyToProject({ ...request, files })).status).toBe('error');
    const unchanged = await client.inspector.artifacts.list({ spaceId: workspaceId, expectedGeneration: 0 });
    if (unchanged.status === 'error') throw unchanged.error;
    expect(unchanged.value.artifacts.filter((entry) => entry.scope === 'base').map((entry) => entry.path)).toEqual(['occupied.txt']);
    const copied = await client.inspector.artifacts.copyToProject({ ...request, files: files.map((file, index) => ({ ...file, destinationPath: `copied/${index}.txt` })) });
    if (copied.status === 'error') throw copied.error;
    await publish(workspaceId, 2, [{ path: 'a.txt', content: 'changed A' }]);
    for (const [index, expected] of ['original A', 'original B'].entries()) {
      const value = await readBytes(client.inspector.artifacts.read({ spaceId: projectId, expectedGeneration: 0, url: `drive://base/copied/${index}.txt`, hash: null }));
      expect(value.toString()).toBe(expected);
    }
    expect((await authority.listArtifactCopies()).sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))).toMatchObject(source.map((entry, index) => ({ sourceHash: entry.blobHash, sourcePath: entry.path, destinationPath: `copied/${index}.txt`, sourceGeneration: 1, destinationGeneration: 2 })));
    expect((await client.inspector.artifacts.copyToProject({ ...request, files: [{ url: 'drive://workspace/a.txt', hash: source[0]!.blobHash, destinationPath: 'stale.txt', expectedDestinationHash: null }] })).status).toBe('error');
  });

  it('replaces only an explicitly confirmed destination version and requires confirmation again after a concurrent edit', async () => {
    const { client, workspaceId, projectId, publish } = await fixture();
    const source = await publish(workspaceId, 1, [{ path: 'report.txt', content: 'selected workspace report' }]);
    const original = await publish(projectId, 1, [{ path: 'report.txt', content: 'original project report' }]);
    const file = { url: 'drive://workspace/report.txt', hash: source[0]!.blobHash, destinationPath: 'report.txt', expectedDestinationHash: original[0]!.blobHash };
    const current = await publish(projectId, 2, [{ path: 'report.txt', content: 'concurrent project edit' }]);
    const request = { spaceId: workspaceId, expectedGeneration: 0, expectedProjectGeneration: 2 };
    // Even with a refreshed manifest generation, consent to the earlier file version is stale.
    expect((await client.inspector.artifacts.copyToProject({ ...request, files: [file] })).status).toBe('error');
    const preserved = await readBytes(client.inspector.artifacts.read({ spaceId: projectId, expectedGeneration: 0, url: 'drive://base/report.txt', hash: null }));
    expect(preserved.toString()).toBe('concurrent project edit');
    const replaced = await client.inspector.artifacts.copyToProject({ ...request, files: [{ ...file, expectedDestinationHash: current[0]!.blobHash }] });
    if (replaced.status === 'error') throw replaced.error;
    const copied = await readBytes(client.inspector.artifacts.read({ spaceId: projectId, expectedGeneration: 0, url: 'drive://base/report.txt', hash: null }));
    expect(copied.toString()).toBe('selected workspace report');
    // Replacement changes the path, not previously published immutable versions.
    const priorVersion = await readBytes(client.inspector.artifacts.read({ spaceId: projectId, expectedGeneration: 0, url: 'drive://base/report.txt', hash: current[0]!.blobHash }));
    expect(priorVersion.toString()).toBe('concurrent project edit');
    const scopeGeneration = replaced.value.scopes.find((scope) => scope.workspaceId === projectId)!.generation;
    const copiedHash = replaced.value.artifacts.find((artifact) => artifact.url === 'drive://base/report.txt')!.hash;
    expect((await client.inspector.artifacts.copyToProject({ ...request, expectedProjectGeneration: scopeGeneration, files: [{ ...file, destinationPath: 'report.txt/child.txt', expectedDestinationHash: copiedHash }] })).status).toBe('error');
  });

  it('serves only the fixed shared version as an attachment, enforcing persisted expiry and revocation', async () => {
    const { client, workspaceId, publish, authority, origin } = await fixture();
    const source = await publish(workspaceId, 1, [{ path: 'demo.html', content: '<script>unsafe()</script>', mediaType: 'text/html' }]);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const created = await client.inspector.artifacts.shares.create({ spaceId: workspaceId, expectedGeneration: 0, url: 'drive://workspace/demo.html', hash: source[0]!.blobHash, expiresAt });
    if (created.status === 'error') throw created.error;
    await publish(workspaceId, 2, [{ path: 'demo.html', content: '<h1>new version</h1>', mediaType: 'text/html' }]);
    const response = await worker.fetch(new Request(new URL(created.value.url, origin)), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/u);
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(await response.text()).toBe('<script>unsafe()</script>');
    expect(await authority.getArtifactShare(created.value.id, expiresAt)).toBeNull();
    const revoked = await client.inspector.artifacts.shares.revoke({ spaceId: workspaceId, expectedGeneration: 0, id: created.value.id });
    expect(revoked).toMatchObject({ status: 'ok', value: { revoked: true } });
    expect((await worker.fetch(new Request(new URL(created.value.url, origin)), env)).status).toBe(404);
    const current = await client.inspector.artifacts.list({ spaceId: workspaceId, expectedGeneration: 0 });
    if (current.status === 'error') throw current.error;
    const expired = await client.inspector.artifacts.shares.create({ spaceId: workspaceId, expectedGeneration: 0, url: 'drive://workspace/demo.html', hash: current.value.artifacts[0]!.hash, expiresAt });
    if (expired.status === 'error') throw expired.error;
    // Simulate a persisted link whose expiry passed, without wall-clock sleeps in the suite.
    await runInDurableObject(authority, (_instance: ProjectAuthorityDO, state) => { state.storage.sql.exec('UPDATE artifact_shares SET expires_at=? WHERE token=?', '2000-01-01T00:00:00.000Z', expired.value.id); });
    expect((await worker.fetch(new Request(new URL(expired.value.url, origin)), env)).status).toBe(404);
    expect(await client.inspector.artifacts.shares.list({ spaceId: workspaceId, expectedGeneration: 0, url: 'drive://workspace/demo.html' })).toMatchObject({ status: 'ok', value: [] });
  });

  it('streams chunked shares completely, keeps preview/copy size limits honest, and rejects corrupt final parts', async () => {
    const { client, workspaceId, publishChunked, origin } = await fixture();
    const artifact = await publishChunked();
    const request = { spaceId: workspaceId, expectedGeneration: 0, url: 'drive://workspace/large.bin', hash: artifact.blobHash };
    const previews = [];
    for await (const frame of client.inspector.artifacts.read(request)) previews.push(frame);
    expect(previews).toMatchObject([{ status: 'error' }]);
    expect((await client.inspector.artifacts.copyToProject({ spaceId: workspaceId, expectedGeneration: 0, expectedProjectGeneration: 0, files: [{ url: request.url, hash: request.hash, destinationPath: 'large.bin', expectedDestinationHash: null }] })).status).toBe('error');
    const created = await client.inspector.artifacts.shares.create({ ...request, expiresAt: null });
    if (created.status === 'error') throw created.error;
    const url = new URL(created.value.url, origin);
    const response = await worker.fetch(new Request(url), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe(String(artifact.size));
    const received = createHash('sha256');
    let size = 0;
    const reader = response.body!.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      received.update(next.value);
    }
    reader.releaseLock();
    expect(size).toBe(artifact.size);
    expect(received.digest('hex')).toBe(artifact.digest);
    await env.DATA.put(artifact.finalKey, new Uint8Array([1, 2, 3]));
    expect((await client.inspector.artifacts.shares.create({ ...request, expiresAt: null })).status).toBe('error');
    expect((await worker.fetch(new Request(url, { method: 'HEAD' }), env)).status).toBe(404);
    const corrupt = await worker.fetch(new Request(url), env);
    await expect((async () => {
      const reader = corrupt.body!.getReader();
      try { while (!(await reader.read()).done) { /* Verify the stream fails, rather than ending successfully. */ } }
      finally { reader.releaseLock(); }
    })()).rejects.toThrow();
  }, 30_000);

  it('uploads binary files in verified sequential chunks and commits them as workspace artifacts', async () => {
    const { client, workspaceId } = await fixture();
    const request = { spaceId: workspaceId, expectedGeneration: 0 };
    const bytes = Uint8Array.from({ length: ARTIFACT_UPLOAD_CHUNK_BYTES + 1_000 }, (_, index) => index % 251);
    const chunk = (offset: number) => {
      const part = bytes.subarray(offset, offset + ARTIFACT_UPLOAD_CHUNK_BYTES);
      return { offset, sha256: createHash('sha256').update(part).digest('hex'), data: Buffer.from(part).toString('base64') };
    };
    const begun = await client.inspector.artifacts.uploadBegin({ ...request, fileName: 'capture 10:30.bin', size: bytes.length, mediaType: 'application/octet-stream' });
    if (begun.status === 'error') throw begun.error;
    expect(begun.value).toMatchObject({ url: 'drive://workspace/uploads/capture%2010%3A30.bin', chunkBytes: ARTIFACT_UPLOAD_CHUNK_BYTES });
    const upload = { ...request, uploadId: begun.value.uploadId };

    expect(await client.inspector.artifacts.uploadChunk({ ...upload, ...chunk(ARTIFACT_UPLOAD_CHUNK_BYTES) })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/inspector-state' } });
    expect(await client.inspector.artifacts.uploadChunk({ ...upload, ...chunk(0) })).toMatchObject({ status: 'ok', value: { received: ARTIFACT_UPLOAD_CHUNK_BYTES } });
    // A lost acknowledgement is retried at the same offset without advancing the upload.
    expect(await client.inspector.artifacts.uploadChunk({ ...upload, ...chunk(0) })).toMatchObject({ status: 'ok', value: { received: ARTIFACT_UPLOAD_CHUNK_BYTES } });
    expect(await client.inspector.artifacts.uploadChunk({ ...upload, ...chunk(ARTIFACT_UPLOAD_CHUNK_BYTES), sha256: '0'.repeat(64) })).toMatchObject({ status: 'error' });
    expect(await client.inspector.artifacts.uploadCommit(upload)).toMatchObject({ status: 'error' });
    expect(await client.inspector.artifacts.uploadChunk({ ...upload, ...chunk(ARTIFACT_UPLOAD_CHUNK_BYTES) })).toMatchObject({ status: 'ok', value: { received: bytes.length } });

    const committed = await client.inspector.artifacts.uploadCommit(upload);
    if (committed.status === 'error') throw committed.error;
    expect(committed.value).toMatchObject({ url: 'drive://workspace/uploads/capture%2010%3A30.bin', path: 'uploads/capture 10:30.bin', size: bytes.length, mediaType: 'application/octet-stream', scope: 'workspace', workspaceId });
    // A ':' in the name is encoded, so it is not read as a `:raw` or line selector.
    const stored = await readBytes(client.inspector.artifacts.read({ ...request, url: committed.value.url, hash: committed.value.hash }));
    expect(stored).toEqual(Buffer.from(bytes));
    expect(await client.inspector.artifacts.uploadAbort(upload)).toMatchObject({ status: 'ok', value: { aborted: false } });

    await expect(client.inspector.artifacts.uploadBegin({ ...request, fileName: 'huge.bin', size: 17 * 1024 * 1024, mediaType: null })).rejects.toThrow('less than or equal to 16777216');
  });
});
