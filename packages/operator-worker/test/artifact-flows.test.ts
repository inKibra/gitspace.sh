import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, createSignedRpcFetch, credentialProtocolBase64, deriveArtifactScopeKey, encryptArtifactBytes, signDeviceInvite, type ArtifactManifest } from '@gitspace/protocol';
import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { createBrowserClient } from 'result-rpc/client';
import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';
import type { ProjectAuthorityDO } from '../src/project-authority.js';

async function fixture() {
  const userId = `u-${crypto.randomUUID().replaceAll('-', '')}`;
  const handle = `artifact-${crypto.randomUUID().slice(0, 8)}`;
  const root = crypto.getRandomValues(new Uint8Array(32));
  const deviceKey = crypto.getRandomValues(new Uint8Array(32));
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(root)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  await env.ACCOUNTS.getByName('global').upsertProvisioning({ userId, handle });
  await env.ACCOUNTS.getByName('global').markActive({ userId, release: null });
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
    await authority.putWorkspace({ id, projectId, kind, name: kind, branch: 'main', phase: kind === 'base' ? null : 'code', sourceKind: 'base', sourceRef: 'main', lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await index.putWorkspaceLocation(id, projectId);
  }
  const key = credentialProtocolBase64.decode(await vault.artifactKey(userId));
  const persist = async (scopeId: string, content: string) => {
    const sealed = await encryptArtifactBytes(new TextEncoder().encode(content), await deriveArtifactScopeKey(key, scopeId));
    const hash = `sha256:${Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', sealed)), (byte) => byte.toString(16).padStart(2, '0')).join('')}` as const;
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
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set('x-gitspace-user', userId);
    return worker.fetch(new Request(request, { headers }), env);
  }) as typeof fetch;
  const client = createBrowserClient({ contract: gitspaceContract, transport: createRoutedTransport({ homeUrl: `${origin}/rpc`, fetch: createSignedRpcFetch({ deviceId: binding.deviceId, signingPrivateKey: deviceKey, fetch: fetcher }) }) });
  return { client, authority, projectId, workspaceId, publish, origin };
}

describe('user artifact flows', () => {
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
      const value = await client.inspector.artifacts.read({ spaceId: projectId, expectedGeneration: 0, url: `local://base/copied/${index}.txt`, hash: null });
      if (value.status === 'error') throw value.error;
      expect(value.value.text).toBe(expected);
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
    const preserved = await client.inspector.artifacts.read({ spaceId: projectId, expectedGeneration: 0, url: 'local://base/report.txt', hash: null });
    if (preserved.status === 'error') throw preserved.error;
    expect(preserved.value.text).toBe('concurrent project edit');
    const replaced = await client.inspector.artifacts.copyToProject({ ...request, files: [{ ...file, expectedDestinationHash: current[0]!.blobHash }] });
    if (replaced.status === 'error') throw replaced.error;
    const copied = await client.inspector.artifacts.read({ spaceId: projectId, expectedGeneration: 0, url: 'local://base/report.txt', hash: null });
    if (copied.status === 'error') throw copied.error;
    expect(copied.value.text).toBe('selected workspace report');
    // Replacement changes the path, not previously published immutable versions.
    const priorVersion = await client.inspector.artifacts.read({ spaceId: projectId, expectedGeneration: 0, url: 'local://base/report.txt', hash: current[0]!.blobHash });
    if (priorVersion.status === 'error') throw priorVersion.error;
    expect(priorVersion.value.text).toBe('concurrent project edit');
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
