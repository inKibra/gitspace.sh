import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, deriveArtifactScopeKey, encryptArtifactBytes, signDeviceInvite, type ArtifactManifest } from '@gitspace/protocol';
import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import type { ResourcePreviewFrame } from '@gitspace/protocol/resource-uri';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { createBrowserClient } from 'result-rpc/client';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { ProjectAuthorityDO } from '../src/project-authority.js';
import { tenantRootPrivateKey } from './setup.js';

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
  const persist = async (scopeId: string, content: string) => {
    const sealed = await encryptArtifactBytes(new TextEncoder().encode(content), await deriveArtifactScopeKey(key, scopeId));
    const hash = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(sealed))), (byte) => byte.toString(16).padStart(2, '0')).join('')}` as const;
    await env.DATA.put(`users/${userId}/accounts/${Buffer.from(userId).toString('base64url')}/artifacts/sha256/${hash.slice(7)}`, sealed);
    return hash;
  };
  const publish = async (spaceId: string, generation: number, files: Array<{ path: string; content: string; mediaType?: string }>) => {
    const scopeId = `space:${spaceId}`;
    const entries: ArtifactManifest['entries'] = [];
    for (const file of files) entries.push({ path: file.path, blobHash: await persist(scopeId, file.content), size: new TextEncoder().encode(file.content).length, mediaType: file.mediaType ?? 'text/plain' });
    const manifestHash = await persist(scopeId, JSON.stringify({ version: 1, scopeId, generation, entries }));
    await authority.putArtifactScope({ id: scopeId, workspaceId: spaceId, generation, expectedGeneration: generation - 1, manifestHash });
    return entries;
  };
  const origin = `https://${handle}.gitspace.sh`;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return worker.fetch(new Request(input, init), env);
  }) as typeof fetch;
  const client = createBrowserClient({ contract: gitspaceContract, transport: createRoutedTransport({ homeUrl: `${origin}/rpc`, fetch: createSignedRpcFetch({ deviceId: binding.deviceId, userId, signingPrivateKey: deviceKey, fetch: fetcher }) }) });
  return { client, authority, projectId, workspaceId, publish, origin };
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
  it('keeps oversized previews inside the RPC error contract and reads selected canonical text ranges', async () => {
    const { client, workspaceId, publish } = await fixture();
    await publish(workspaceId, 1, [{ path: 'output.txt', content: `selected line\n${'remaining output\n'.repeat(20_000)}` }]);
    const request = { spaceId: workspaceId, expectedGeneration: 0, hash: null };
    const full = [];
    for await (const frame of client.inspector.artifacts.read({ ...request, url: 'local://workspace/output.txt' })) full.push(frame);
    expect(full).toMatchObject([{ status: 'error' }]);
    const selected = await readBytes(client.inspector.artifacts.read({ ...request, url: 'local://workspace/output.txt:raw:1-1' }));
    expect(selected.toString()).toBe('selected line');
  });

  it('streams encrypted published audio beyond a single RPC reply without changing bytes', async () => {
    const { client, workspaceId, publish } = await fixture();
    const content = '\0'.repeat(1024 * 1024 + 17);
    const entries = await publish(workspaceId, 1, [{ path: 'capture.wav', content, mediaType: 'audio/wav' }]);
    const bytes = await readBytes(client.inspector.artifacts.read({ spaceId: workspaceId, expectedGeneration: 0, url: 'local://workspace/capture.wav', hash: entries[0]!.blobHash }));
    expect(bytes).toEqual(Buffer.from(content));
  });

  it('rejects a conflicting batch atomically and keeps re-encrypted project copies independent of later workspace edits', async () => {
    const setup = await fixture();
    const { client, projectId, workspaceId, publish, authority } = setup;
    const source = await publish(workspaceId, 1, [{ path: 'a.txt', content: 'original A' }, { path: 'b.txt', content: 'original B' }]);
    await publish(projectId, 1, [{ path: 'occupied.txt', content: 'keep project content' }]);
    const request = { spaceId: workspaceId, expectedGeneration: 0, expectedProjectGeneration: 1 };
    const files = source.map((entry, index) => ({ url: `local://workspace/${entry.path}`, hash: entry.blobHash, destinationPath: index === 0 ? 'copied/a.txt' : 'occupied.txt', expectedDestinationHash: null }));
    expect((await client.inspector.artifacts.copyToProject({ ...request, files })).status).toBe('error');
    const unchanged = await client.inspector.artifacts.list({ spaceId: workspaceId, expectedGeneration: 0 });
    if (unchanged.status === 'error') throw unchanged.error;
    expect(unchanged.value.artifacts.filter((entry) => entry.scope === 'base').map((entry) => entry.path)).toEqual(['occupied.txt']);
    const copied = await client.inspector.artifacts.copyToProject({ ...request, files: files.map((file, index) => ({ ...file, destinationPath: `copied/${index}.txt` })) });
    if (copied.status === 'error') throw copied.error;
    await publish(workspaceId, 2, [{ path: 'a.txt', content: 'changed A' }]);
    for (const [index, expected] of ['original A', 'original B'].entries()) {
      const value = await readBytes(client.inspector.artifacts.read({ spaceId: projectId, expectedGeneration: 0, url: `local://base/copied/${index}.txt`, hash: null }));
      expect(value.toString()).toBe(expected);
    }
    expect((await authority.listArtifactCopies()).sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))).toMatchObject(source.map((entry, index) => ({ sourceHash: entry.blobHash, sourcePath: entry.path, destinationPath: `copied/${index}.txt`, sourceGeneration: 1, destinationGeneration: 2 })));
    expect((await client.inspector.artifacts.copyToProject({ ...request, files: [{ url: 'local://workspace/a.txt', hash: source[0]!.blobHash, destinationPath: 'stale.txt', expectedDestinationHash: null }] })).status).toBe('error');
  });

  it('replaces only an explicitly confirmed destination version and requires confirmation again after a concurrent edit', async () => {
    const { client, workspaceId, projectId, publish } = await fixture();
    const source = await publish(workspaceId, 1, [{ path: 'report.txt', content: 'selected workspace report' }]);
    const original = await publish(projectId, 1, [{ path: 'report.txt', content: 'original project report' }]);
    const file = { url: 'local://workspace/report.txt', hash: source[0]!.blobHash, destinationPath: 'report.txt', expectedDestinationHash: original[0]!.blobHash };
    const current = await publish(projectId, 2, [{ path: 'report.txt', content: 'concurrent project edit' }]);
    const request = { spaceId: workspaceId, expectedGeneration: 0, expectedProjectGeneration: 2 };
    // Even with a refreshed manifest generation, consent to the earlier file version is stale.
    expect((await client.inspector.artifacts.copyToProject({ ...request, files: [file] })).status).toBe('error');
    const preserved = await readBytes(client.inspector.artifacts.read({ spaceId: projectId, expectedGeneration: 0, url: 'local://base/report.txt', hash: null }));
    expect(preserved.toString()).toBe('concurrent project edit');
    const replaced = await client.inspector.artifacts.copyToProject({ ...request, files: [{ ...file, expectedDestinationHash: current[0]!.blobHash }] });
    if (replaced.status === 'error') throw replaced.error;
    const copied = await readBytes(client.inspector.artifacts.read({ spaceId: projectId, expectedGeneration: 0, url: 'local://base/report.txt', hash: null }));
    expect(copied.toString()).toBe('selected workspace report');
    // Replacement changes the path, not previously published immutable versions.
    const priorVersion = await readBytes(client.inspector.artifacts.read({ spaceId: projectId, expectedGeneration: 0, url: 'local://base/report.txt', hash: current[0]!.blobHash }));
    expect(priorVersion.toString()).toBe('concurrent project edit');
    const scopeGeneration = replaced.value.scopes.find((scope) => scope.workspaceId === projectId)!.generation;
    const copiedHash = replaced.value.artifacts.find((artifact) => artifact.url === 'local://base/report.txt')!.hash;
    expect((await client.inspector.artifacts.copyToProject({ ...request, expectedProjectGeneration: scopeGeneration, files: [{ ...file, destinationPath: 'report.txt/child.txt', expectedDestinationHash: copiedHash }] })).status).toBe('error');
  });

  it('serves only the fixed shared version as an attachment, enforcing persisted expiry and revocation', async () => {
    const { client, workspaceId, publish, authority, origin } = await fixture();
    const source = await publish(workspaceId, 1, [{ path: 'demo.html', content: '<script>unsafe()</script>', mediaType: 'text/html' }]);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const created = await client.inspector.artifacts.shares.create({ spaceId: workspaceId, expectedGeneration: 0, url: 'local://workspace/demo.html', hash: source[0]!.blobHash, expiresAt });
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
    const expired = await client.inspector.artifacts.shares.create({ spaceId: workspaceId, expectedGeneration: 0, url: 'local://workspace/demo.html', hash: current.value.artifacts[0]!.hash, expiresAt });
    if (expired.status === 'error') throw expired.error;
    // Simulate a persisted link whose expiry passed, without wall-clock sleeps in the suite.
    await runInDurableObject(authority, (_instance: ProjectAuthorityDO, state) => { state.storage.sql.exec('UPDATE artifact_shares SET expires_at=? WHERE token=?', '2000-01-01T00:00:00.000Z', expired.value.id); });
    expect((await worker.fetch(new Request(new URL(expired.value.url, origin)), env)).status).toBe(404);
    expect(await client.inspector.artifacts.shares.list({ spaceId: workspaceId, expectedGeneration: 0, url: 'local://workspace/demo.html' })).toMatchObject({ status: 'ok', value: [] });
  });
});
