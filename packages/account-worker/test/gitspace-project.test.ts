import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64, DEFAULT_INFERENCE_PROFILE_ID } from '@gitspace/protocol';
import { ensureAccountGitSpaceProject } from '../src/gitspace-project.js';
import { requireRuntimeIdentity } from '../src/runtime-access.js';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { tenantRootPrivateKey } from './setup.js';

describe('account GitSpace source provenance', () => {
  it('assigns the reserved source project once and preserves its selected profile during account repair', async () => {
    const userId = env.ACCOUNT_ID;
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({
      userId,
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)),
      vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)),
    });
    await vault.ensureInference();
    const cloudEnv = { ...env, ASSETS: { fetch: async () => Response.json({ release: 'channel:test', branch: 'main', commit: 'a'.repeat(40) }), connect: (address, options) => env.ASSETS.connect(address, options) } satisfies Fetcher };
    const [first, concurrent] = await Promise.all([
      ensureAccountGitSpaceProject(cloudEnv, userId),
      ensureAccountGitSpaceProject(cloudEnv, userId),
    ]);
    expect(concurrent.id).toBe(first.id);
    expect((await vault.ensureInference()).assignments).toEqual([{ projectId: first.id, profileId: DEFAULT_INFERENCE_PROFILE_ID, revision: 0 }]);

    const created = await vault.createInferenceProfile({ name: 'Source work', sourceProfileId: null });
    const profile = created.profiles.find((candidate) => candidate.id !== DEFAULT_INFERENCE_PROFILE_ID)!;
    await vault.assignInferenceProfile({ projectId: first.id, profileId: profile.id, expectedRevision: 0 });
    expect((await ensureAccountGitSpaceProject(cloudEnv, userId)).id).toBe(first.id);
    expect((await vault.ensureInference()).assignments).toEqual([{ projectId: first.id, profileId: profile.id, revision: 1 }]);
  });

  it('uses the channel frontend metadata rather than an unrelated fallback branch', async () => {
    const userId = env.ACCOUNT_ID;
    const metadata = { release: 'a'.repeat(40), branch: 'release/channel', commit: 'a'.repeat(40) };
    const cloudEnv = { ...env, ASSETS: { fetch: async (input) => new URL(input instanceof Request ? input.url : input.toString()).pathname === '/__account/gitspace-source.json'
      ? Response.json(metadata) : new Response('Not found', { status: 404 }), connect: (address, options) => env.ASSETS.connect(address, options) } satisfies Fetcher };
    const project = await ensureAccountGitSpaceProject(cloudEnv, userId, { sourceBranch: 'unrelated', sourceCommit: 'c'.repeat(40) });
    expect(project).toMatchObject({ lifecycle: 'cloud-only', baseBranch: metadata.branch, source: metadata });
    expect(await env.PROJECT_AUTHORITY.getByName(`${userId}:${project.id}`).listWorkspaces()).toEqual([]);
  });

  it('lets a machine write runtime state while it opens the cloud-only source project', async () => {
    const userId = env.ACCOUNT_ID;
    const metadata = { release: 'b'.repeat(40), branch: 'main', commit: 'b'.repeat(40) };
    const cloudEnv = { ...env, ASSETS: { fetch: async () => Response.json(metadata), connect: (address, options) => env.ASSETS.connect(address, options) } satisfies Fetcher };
    const project = await ensureAccountGitSpaceProject(cloudEnv, userId);
    expect(project.lifecycle).toBe('cloud-only');
    const identity = RuntimeIdentitySchema.parse({ projectId: project.id, workspaceId: project.id });
    await expect(requireRuntimeIdentity(env, userId, identity, true)).resolves.toMatchObject({ project: { id: project.id } });
  });

  it('pins the selected account frontend and its source branch instead of the channel build', async () => {
    const userId = env.ACCOUNT_ID;
    const sha = 'd'.repeat(40);
    const key = `releases/${sha}/frontend`;
    const releases = env.TENANT_RELEASES.getByName(userId);
    await releases.stage({
      sha, label: 'Account frontend', workspaceId: null,
      artifacts: { worker: null, machine: null, frontend: { key, hash: `sha256:${'a'.repeat(64)}`, size: 1 } },
      worker: null,
    }, 'human');
    await releases.launch({ sha, targets: ['frontend'] });
    await env.DATA.put(`users/${userId}/${key}/gitspace-source.json`, JSON.stringify({ release: sha, branch: 'account/source', commit: sha }));
    const cloudEnv = { ...env, ASSETS: { fetch: async () => Response.json({ release: 'channel:other', branch: 'other', commit: 'e'.repeat(40) }), connect: (address, options) => env.ASSETS.connect(address, options) } satisfies Fetcher };
    const project = await ensureAccountGitSpaceProject(cloudEnv, userId, { sourceBranch: 'wrong-fallback' });
    expect(project.source).toEqual({ release: sha, branch: 'account/source', commit: sha });
    expect(project.baseBranch).toBe('account/source');
  });
});
