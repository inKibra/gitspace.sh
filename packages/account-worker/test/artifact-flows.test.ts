import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { artifactObjectKey, createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, DRIVE_FILE_MAX_BYTES, signDeviceInvite, TENANT_OBJECT_PART_BYTES, type ArtifactManifest } from '@gitspace/protocol';
import { ARTIFACT_UPLOAD_CHUNK_BYTES, DRIVE_UPLOAD_PATH, gitspaceContract } from '@gitspace/protocol/rpc-contract';
import type { ResourcePreviewFrame } from '@gitspace/protocol/resource-uri';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { createBrowserClient } from 'result-rpc/client';
import { describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import type { ProjectAuthorityDO } from '../src/project-authority.js';
import { tenantRootPrivateKey } from './setup.js';
import { createHash } from 'node:crypto';
import { tenantObjectKey, tenantStore } from '../src/tenant-store.js';
import { InspectorCloudArtifacts, readInspectorContext } from '../src/account-inspector-data.js';
import { pattern, streamedSha256 } from './drive-bytes.js';

const sha256 = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

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
  const tenant = tenantStore(env);
  const store = async (scopeId: string, bytes: Uint8Array) => {
    const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
    await tenant.put(artifactObjectKey(userId, scopeId, hash), scopeId, bytes);
    return hash;
  };
  const persist = (scopeId: string, content: string) => store(scopeId, new TextEncoder().encode(content));
  const publish = async (spaceId: string, generation: number, files: Array<{ path: string; content: string; mediaType?: string }>) => {
    const scopeId = `space:${spaceId}`;
    const entries: ArtifactManifest['entries'] = [];
    for (const file of files) entries.push({ path: file.path, blobHash: await persist(scopeId, file.content), size: new TextEncoder().encode(file.content).length, mediaType: file.mediaType ?? 'text/plain' });
    const manifestHash = await persist(scopeId, JSON.stringify({ version: 1, scopeId, generation, entries }));
    await authority.putArtifactScope({ id: scopeId, workspaceId: spaceId, generation, expectedGeneration: generation - 1, manifestHash });
    return entries;
  };
  /** A file above one part: stored as uniform multipart parts, ones then a 17-byte tail of twos. */
  const publishLarge = async () => {
    const scopeId = `space:${workspaceId}`;
    const size = TENANT_OBJECT_PART_BYTES + 17;
    const bytes = new Uint8Array(size).fill(1);
    bytes.fill(2, TENANT_OBJECT_PART_BYTES);
    const blobHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as const;
    const name = artifactObjectKey(userId, scopeId, blobHash);
    const writer = tenant.writer(name, scopeId, { sha256: blobHash, size });
    for (let offset = 0; offset < size; offset += 1024 * 1024) await writer.write(bytes.subarray(offset, offset + 1024 * 1024));
    await writer.close();
    const entries = [{ path: 'large.bin', blobHash, size, mediaType: 'application/octet-stream' }];
    const manifestHash = await persist(scopeId, JSON.stringify({ version: 1, scopeId, generation: 1, entries }));
    await authority.putArtifactScope({ id: scopeId, workspaceId, generation: 1, expectedGeneration: 0, manifestHash });
    return { blobHash, size, bytes, key: tenantObjectKey(userId, name) };
  };
  const origin = `https://${handle}.gitspace.sh`;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return worker.fetch(new Request(input, init), env);
  }) as typeof fetch;
  const signed = createSignedRpcFetch({ deviceId: binding.deviceId, userId, signingPrivateKey: deviceKey, fetch: fetcher });
  const client = createBrowserClient({ contract: gitspaceContract, transport: createRoutedTransport({ homeUrl: `${origin}/rpc`, fetch: signed }) });
  return { client, authority, projectId, workspaceId, publish, publishLarge, origin, store, signed, fetcher };
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
    await publish(workspaceId, 1, [{ path: 'output.txt', content: `retained line\n${'large output\n'.repeat(330_000)}` }]);
    const request = { spaceId: workspaceId, expectedGeneration: 0, sessionId: null, url: 'drive://output.txt' };
    const frames = [];
    for await (const frame of client.inspector.resources.read(request)) frames.push(frame);
    expect(frames).toMatchObject([{ status: 'error', error: { _tag: 'gitspace/operation-failed' } }]);
    expect(await client.inspector.resources.readPage({ ...request, cursor: null, limit: 16 })).toMatchObject({ status: 'error', error: { _tag: 'gitspace/operation-failed' } });
    expect((await readBytes(client.inspector.resources.read({ ...request, url: `${request.url}:1-1` }))).toString()).toBe('retained line');
  });

  it('keeps oversized previews inside the RPC error contract and reads selected canonical text ranges', async () => {
    const { client, workspaceId, publish } = await fixture();
    await publish(workspaceId, 1, [{ path: 'output.txt', content: `selected line\n${'remaining output\n'.repeat(250_000)}` }]);
    const request = { spaceId: workspaceId, expectedGeneration: 0, hash: null };
    const full = [];
    for await (const frame of client.inspector.artifacts.read({ ...request, url: 'drive://workspace/output.txt' })) full.push(frame);
    expect(full).toMatchObject([{ status: 'error' }]);
    const selected = await readBytes(client.inspector.artifacts.read({ ...request, url: 'drive://workspace/output.txt:raw:1-1' }));
    expect(selected.toString()).toBe('selected line');
    // A report with inline images runs to a few MiB and previews whole.
    const report = `<html><body>${'<img src="data:image/png;base64,AAAA">'.repeat(30_000)}</body></html>`;
    await publish(workspaceId, 2, [{ path: 'report.html', content: report, mediaType: 'text/html' }]);
    expect((await readBytes(client.inspector.artifacts.read({ ...request, url: 'drive://workspace/report.html' }))).toString()).toBe(report);
  });

  it('streams encrypted published audio beyond a single RPC reply without changing bytes', async () => {
    const { client, workspaceId, publish } = await fixture();
    const content = '\0'.repeat(1024 * 1024 + 17);
    const entries = await publish(workspaceId, 1, [{ path: 'capture.wav', content, mediaType: 'audio/wav' }]);
    const bytes = await readBytes(client.inspector.artifacts.read({ spaceId: workspaceId, expectedGeneration: 0, url: 'drive://workspace/capture.wav', hash: entries[0]!.blobHash }));
    expect(bytes).toEqual(Buffer.from(content));
  });

  it('names a file a machine stored only when the workspace scope holds it at its digest and size', async () => {
    const { client, workspaceId, projectId, store } = await fixture();
    const artifacts = new InspectorCloudArtifacts(env, env.ACCOUNT_ID, await readInspectorContext(env, env.ACCOUNT_ID, workspaceId, projectId));
    const zip = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 7) % 256);
    const target = await artifacts.machineTarget('drive://workspace/uploads/font.zip');
    expect(target).toEqual({ scopeId: `space:${workspaceId}`, path: 'uploads/font.zip' });
    // Stored in the project's scope, the object is not this workspace's and nothing is named.
    const foreign = await store(`space:${projectId}`, zip);
    await expect(artifacts.write('drive://workspace/uploads/font.zip', { stored: { blobHash: foreign, size: zip.byteLength }, mediaType: 'application/zip' })).rejects.toThrow();
    const stored = { blobHash: await store(target.scopeId, zip), size: zip.byteLength };
    await expect(artifacts.write('drive://workspace/uploads/font.zip', { stored: { ...stored, size: zip.byteLength + 1 }, mediaType: 'application/zip' })).rejects.toThrow();
    expect((await artifacts.list()).map(entry => entry.path)).toEqual([]);
    const written = await artifacts.write('drive://workspace/uploads/font.zip', { stored, mediaType: 'application/zip' });
    expect(written).toMatchObject({ url: 'drive://workspace/uploads/font.zip', hash: stored.blobHash, size: zip.byteLength, mediaType: 'application/zip' });
    expect(await artifacts.locate('drive://workspace/uploads/font.zip')).toEqual({ scopeId: target.scopeId, ...stored });
    const bytes = await readBytes(client.inspector.artifacts.read({ spaceId: workspaceId, expectedGeneration: 0, url: 'drive://workspace/uploads/font.zip', hash: null }));
    expect(bytes).toEqual(Buffer.from(zip));
  });

  it('stores every drive file in its scope under its plaintext digest and size', async () => {
    const { workspaceId, projectId } = await fixture();
    const artifacts = new InspectorCloudArtifacts(env, env.ACCOUNT_ID, await readInspectorContext(env, env.ACCOUNT_ID, workspaceId, projectId));
    const bytes = new TextEncoder().encode('drive notes');
    const written = await artifacts.write('drive://workspace/notes.txt', { bytes });
    expect(written.hash).toBe(`sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    const stored = await env.DATA.head(tenantObjectKey(env.ACCOUNT_ID, artifactObjectKey(env.ACCOUNT_ID, `space:${workspaceId}`, written.hash)));
    expect(stored?.customMetadata).toEqual({ scope: `space:${workspaceId}`, sha256: written.hash, size: String(bytes.byteLength) });
  });

  it('rejects a conflicting batch atomically and keeps project copies independent of later workspace edits', async () => {
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

  it('serves a drive file from a sealed short-lived URL with byte ranges, and never as an active page', async () => {
    const { client, workspaceId, publish, origin } = await fixture();
    const audio = Array.from({ length: 1000 }, (_, index) => String.fromCharCode(65 + index % 26)).join('');
    const [first] = await publish(workspaceId, 1, [{ path: 'take one.wav', content: audio, mediaType: 'audio/wav' }]);
    const minted = await client.inspector.artifacts.file({ spaceId: workspaceId, expectedGeneration: 0, url: 'drive://workspace/take%20one.wav', hash: null });
    if (minted.status === 'error') throw minted.error;
    expect(minted.value).toMatchObject({ size: 1000, mediaType: 'audio/wav' });
    const get = (path: string, headers: Record<string, string> = {}, method = 'GET') => worker.fetch(new Request(new URL(path, origin), { method, headers }), env);
    const whole = await get(minted.value.url);
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe(audio);
    expect(Object.fromEntries(['content-type', 'content-length', 'accept-ranges', 'x-content-type-options'].map(name => [name, whole.headers.get(name)]))).toEqual({ 'content-type': 'audio/wav', 'content-length': '1000', 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' });
    expect(whole.headers.get('content-security-policy')).toContain('sandbox');
    expect(whole.headers.get('content-disposition')).toMatch(/^inline;.*take%20one\.wav$/u);
    const middle = await get(minted.value.url, { range: 'bytes=26-51' });
    expect(middle.status).toBe(206);
    expect(middle.headers.get('content-range')).toBe('bytes 26-51/1000');
    expect(await middle.text()).toBe(audio.slice(26, 52));
    expect(await (await get(minted.value.url, { range: 'bytes=-4' })).text()).toBe(audio.slice(-4));
    expect((await get(minted.value.url, { range: 'bytes=1000-' })).status).toBe(416);
    expect((await get(minted.value.url, { 'if-none-match': `"${first!.blobHash}"` })).status).toBe(304);
    expect((await get(minted.value.downloadUrl)).headers.get('content-disposition')).toMatch(/^attachment;/u);
    const head = await get(minted.value.url, {}, 'HEAD');
    expect([head.status, head.headers.get('content-length'), await head.text()]).toEqual([200, '1000', '']);
    // A token cannot be altered, and stops working when it expires.
    const token = minted.value.url.slice('/files/'.length);
    expect((await get(`/files/${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`)).status).toBe(404);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(minted.value.expiresAt) + 1);
    try { expect((await get(minted.value.url)).status).toBe(404); } finally { vi.restoreAllMocks(); }

    // HTML and SVG are files to save, never pages of this origin.
    await publish(workspaceId, 2, [{ path: 'report.html', content: '<script>steal()</script>', mediaType: 'text/html' }, { path: 'take one.wav', content: 'replaced', mediaType: 'audio/wav' }]);
    const html = await client.inspector.artifacts.file({ spaceId: workspaceId, expectedGeneration: 0, url: 'drive://workspace/report.html', hash: null });
    if (html.status === 'error') throw html.error;
    expect((await get(html.value.url)).headers.get('content-disposition')).toMatch(/^attachment;/u);
    // An earlier version, pinned by hash, keeps its own bytes and size.
    const pinned = await client.inspector.artifacts.file({ spaceId: workspaceId, expectedGeneration: 0, url: 'drive://workspace/take%20one.wav', hash: first!.blobHash });
    if (pinned.status === 'error') throw pinned.error;
    expect(pinned.value.size).toBe(1000);
    expect(await (await get(pinned.value.url, { range: 'bytes=0-1' })).text()).toBe('AB');
  });

  it('serves a range at the end of a multipart file', async () => {
    const { client, workspaceId, publishLarge, origin } = await fixture();
    const chunked = await publishLarge();
    const large = await client.inspector.artifacts.file({ spaceId: workspaceId, expectedGeneration: 0, url: 'drive://workspace/large.bin', hash: chunked.blobHash });
    if (large.status === 'error') throw large.error;
    const tail = await worker.fetch(new Request(new URL(large.value.url, origin), { headers: { range: `bytes=${chunked.size - 20}-` } }), env);
    expect(tail.status).toBe(206);
    expect(tail.headers.get('content-range')).toBe(`bytes ${chunked.size - 20}-${chunked.size - 1}/${chunked.size}`);
    expect([...new Uint8Array(await tail.arrayBuffer())]).toEqual([...Array(3).fill(1), ...Array(17).fill(2)]);
  }, 30_000);

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

  it('streams large shares completely, keeps preview/copy size limits honest, and refuses corrupted objects', async () => {
    const { client, workspaceId, publishLarge, origin } = await fixture();
    const artifact = await publishLarge();
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
    expect(`sha256:${received.digest('hex')}`).toBe(artifact.blobHash);
    const metadata = (await env.DATA.head(artifact.key))!.customMetadata;
    // The same recorded digest and size over a changed final byte: no link is published for it.
    const tampered = Uint8Array.from(artifact.bytes);
    tampered[tampered.byteLength - 1] = 3;
    await env.DATA.put(artifact.key, tampered, { customMetadata: metadata });
    expect((await client.inspector.artifacts.shares.create({ ...request, expiresAt: null })).status).toBe('error');
    // A body of another size is refused before any byte is served.
    await env.DATA.put(artifact.key, new Uint8Array([1, 2, 3]), { customMetadata: metadata });
    expect((await worker.fetch(new Request(url, { method: 'HEAD' }), env)).status).toBe(404);
    expect((await worker.fetch(new Request(url), env)).status).toBe(404);
  }, 60_000);

  it('uploads binary files in verified sequential chunks, commits them as workspace artifacts and serves them by URL', async () => {
    const { client, workspaceId, origin } = await fixture();
    const request = { spaceId: workspaceId, expectedGeneration: 0 };
    const bytes = Uint8Array.from({ length: ARTIFACT_UPLOAD_CHUNK_BYTES + 1_000 }, (_, index) => index % 251);
    const chunk = (offset: number) => {
      const part = bytes.subarray(offset, offset + ARTIFACT_UPLOAD_CHUNK_BYTES);
      return { offset, sha256: createHash('sha256').update(part).digest('hex'), data: Buffer.from(part).toString('base64') };
    };
    const begun = await client.inspector.artifacts.uploadBegin({ ...request, fileName: 'capture 10:30.bin', size: bytes.length, sha256: sha256(bytes).slice(7), mediaType: 'application/octet-stream' });
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
    expect(committed.value).toMatchObject({ url: 'drive://workspace/uploads/capture%2010%3A30.bin', path: 'uploads/capture 10:30.bin', hash: sha256(bytes), size: bytes.length, mediaType: 'application/octet-stream', scope: 'workspace', workspaceId });
    // A ':' in the name is encoded, so it is not read as a `:raw` or line selector.
    const stored = await readBytes(client.inspector.artifacts.read({ ...request, url: committed.value.url, hash: committed.value.hash }));
    expect(stored).toEqual(Buffer.from(bytes));
    const minted = await client.inspector.artifacts.file({ ...request, url: committed.value.url, hash: null });
    if (minted.status === 'error') throw minted.error;
    const ranged = await worker.fetch(new Request(new URL(minted.value.url, origin), { headers: { range: `bytes=${ARTIFACT_UPLOAD_CHUNK_BYTES - 2}-${ARTIFACT_UPLOAD_CHUNK_BYTES + 1}` } }), env);
    expect([ranged.status, ranged.headers.get('content-range')]).toEqual([206, `bytes ${ARTIFACT_UPLOAD_CHUNK_BYTES - 2}-${ARTIFACT_UPLOAD_CHUNK_BYTES + 1}/${bytes.length}`]);
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.subarray(ARTIFACT_UPLOAD_CHUNK_BYTES - 2, ARTIFACT_UPLOAD_CHUNK_BYTES + 2));
    expect(await client.inspector.artifacts.uploadAbort(upload)).toMatchObject({ status: 'ok', value: { aborted: false } });

    // Bytes that miss the digest declared at begin are never published.
    const mismatched = new Uint8Array([1, 2, 3]);
    const declared = await client.inspector.artifacts.uploadBegin({ ...request, fileName: 'mismatched.bin', size: 3, sha256: '0'.repeat(64), mediaType: null });
    if (declared.status === 'error') throw declared.error;
    const other = { ...request, uploadId: declared.value.uploadId };
    expect(await client.inspector.artifacts.uploadChunk({ ...other, offset: 0, sha256: sha256(mismatched).slice(7), data: Buffer.from(mismatched).toString('base64') })).toMatchObject({ status: 'ok' });
    expect(await client.inspector.artifacts.uploadCommit(other)).toMatchObject({ status: 'error' });
    const listed = await client.inspector.artifacts.list(request);
    if (listed.status === 'error') throw listed.error;
    expect(listed.value.artifacts.map(artifact => artifact.path)).toEqual(['uploads/capture 10:30.bin']);

    await expect(client.inspector.artifacts.uploadBegin({ ...request, fileName: 'huge.bin', size: DRIVE_FILE_MAX_BYTES + 1, sha256: '0'.repeat(64), mediaType: null })).rejects.toThrow(`less than or equal to ${DRIVE_FILE_MAX_BYTES}`);
  });

  it('commits a browser upload larger than one part, sending each full part as its chunks arrive', async () => {
    const { client, workspaceId, origin } = await fixture();
    const request = { spaceId: workspaceId, expectedGeneration: 0 };
    const size = TENANT_OBJECT_PART_BYTES + ARTIFACT_UPLOAD_CHUNK_BYTES + 7;
    const digest = createHash('sha256');
    for (let offset = 0; offset < size; offset += ARTIFACT_UPLOAD_CHUNK_BYTES) digest.update(pattern(offset, Math.min(ARTIFACT_UPLOAD_CHUNK_BYTES, size - offset)));
    const hash = digest.digest('hex');
    const begun = await client.inspector.artifacts.uploadBegin({ ...request, fileName: 'screen.webm', size, sha256: hash, mediaType: 'video/webm' });
    if (begun.status === 'error') throw begun.error;
    const upload = { ...request, uploadId: begun.value.uploadId };
    for (let offset = 0; offset < size; offset += ARTIFACT_UPLOAD_CHUNK_BYTES) {
      const part = pattern(offset, Math.min(ARTIFACT_UPLOAD_CHUNK_BYTES, size - offset));
      const sent = await client.inspector.artifacts.uploadChunk({ ...upload, offset, sha256: createHash('sha256').update(part).digest('hex'), data: Buffer.from(part).toString('base64') });
      if (sent.status === 'error') throw sent.error;
    }
    const committed = await client.inspector.artifacts.uploadCommit(upload);
    if (committed.status === 'error') throw committed.error;
    expect(committed.value).toMatchObject({ path: 'uploads/screen.webm', hash: `sha256:${hash}`, size, mediaType: 'video/webm' });
    const minted = await client.inspector.artifacts.file({ ...request, url: committed.value.url, hash: null });
    if (minted.status === 'error') throw minted.error;
    const url = new URL(minted.value.url, origin);
    const boundary = await worker.fetch(new Request(url, { headers: { range: `bytes=${TENANT_OBJECT_PART_BYTES - 3}-${TENANT_OBJECT_PART_BYTES + 2}` } }), env);
    expect([boundary.status, boundary.headers.get('content-range'), new Uint8Array(await boundary.arrayBuffer())]).toEqual([206, `bytes ${TENANT_OBJECT_PART_BYTES - 3}-${TENANT_OBJECT_PART_BYTES + 2}/${size}`, pattern(TENANT_OBJECT_PART_BYTES - 3, 6)]);
    const whole = await worker.fetch(new Request(url), env);
    expect([whole.status, whole.headers.get('content-length')]).toEqual([200, String(size)]);
    expect(await streamedSha256(whole.body!)).toBe(`sha256:${hash}`);
  }, 180_000);

  it('takes raw device-signed parts of a declared upload into a workspace scope and publishes it once the digest matches', async () => {
    const { client, signed, fetcher, workspaceId, projectId, origin } = await fixture();
    const request = { spaceId: workspaceId, expectedGeneration: 0 };
    const size = TENANT_OBJECT_PART_BYTES + 7;
    const digest = createHash('sha256').update(pattern(0, TENANT_OBJECT_PART_BYTES)).update(pattern(TENANT_OBJECT_PART_BYTES, 7)).digest('hex');
    const begun = await client.inspector.artifacts.uploadBegin({ ...request, fileName: 'release-check.bin', size, sha256: digest, mediaType: 'application/octet-stream' });
    if (begun.status === 'error') throw begun.error;
    expect(begun.value.partBytes).toBe(TENANT_OBJECT_PART_BYTES);
    const put = (partNumber: number, bytes: Uint8Array<ArrayBuffer>, options: { spaceId?: string; send?: typeof fetch } = {}) => (options.send ?? signed)(
      `${origin}${DRIVE_UPLOAD_PATH}/${begun.value.uploadId}/parts/${partNumber}?spaceId=${options.spaceId ?? workspaceId}&expectedGeneration=0`,
      { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.byteLength) } },
    );
    const first = pattern(0, TENANT_OBJECT_PART_BYTES);
    // Unsigned, or signed for another space, a part is refused.
    expect((await put(1, first, { send: fetcher })).status).toBe(401);
    expect((await put(1, pattern(0, 7), { spaceId: projectId })).status).toBe(409);
    expect((await put(1, pattern(0, 7))).status).toBe(409);
    const stored = await put(1, first);
    expect([stored.status, await stored.json()]).toEqual([200, { status: 'ok', value: { received: TENANT_OBJECT_PART_BYTES } }]);
    // A resent part is acknowledged; a skipped one is refused.
    expect(await (await put(1, first)).json()).toEqual({ status: 'ok', value: { received: TENANT_OBJECT_PART_BYTES } });
    expect((await put(3, pattern(0, 7))).status).toBe(409);
    expect(await (await put(2, pattern(TENANT_OBJECT_PART_BYTES, 7))).json()).toEqual({ status: 'ok', value: { received: size } });
    const committed = await client.inspector.artifacts.uploadCommit({ ...request, uploadId: begun.value.uploadId });
    if (committed.status === 'error') throw committed.error;
    expect(committed.value).toMatchObject({ path: 'uploads/release-check.bin', hash: `sha256:${digest}`, size, scope: 'workspace', workspaceId });
    const minted = await client.inspector.artifacts.file({ ...request, url: committed.value.url, hash: null });
    if (minted.status === 'error') throw minted.error;
    const ranged = await worker.fetch(new Request(new URL(minted.value.url, origin), { headers: { range: `bytes=${TENANT_OBJECT_PART_BYTES - 3}-${TENANT_OBJECT_PART_BYTES + 2}` } }), env);
    expect([ranged.status, new Uint8Array(await ranged.arrayBuffer())]).toEqual([206, pattern(TENANT_OBJECT_PART_BYTES - 3, 6)]);

    // Raw parts that miss the declared digest are never published.
    const wrong = await client.inspector.artifacts.uploadBegin({ ...request, fileName: 'wrong.bin', size: 3, sha256: '0'.repeat(64), mediaType: null });
    if (wrong.status === 'error') throw wrong.error;
    expect((await signed(`${origin}${DRIVE_UPLOAD_PATH}/${wrong.value.uploadId}/parts/1?spaceId=${workspaceId}&expectedGeneration=0`, { method: 'PUT', body: new Uint8Array([1, 2, 3]), headers: { 'content-length': '3' } })).status).toBe(409);
    expect(await client.inspector.artifacts.uploadCommit({ ...request, uploadId: wrong.value.uploadId })).toMatchObject({ status: 'error' });
  }, 180_000);
});
