import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ensureAccountGitSpaceProject } from '../src/gitspace-project.js';

describe('account GitSpace source provenance', () => {
  it('uses the channel frontend metadata rather than an unrelated fallback branch', async () => {
    const userId = env.ACCOUNT_ID;
    const metadata = { release: 'a'.repeat(40), branch: 'release/channel', commit: 'a'.repeat(40) };
    const cloudEnv = { ...env, ASSETS: { fetch: async (request: Request) => new URL(request.url).pathname === '/__account/gitspace-source.json'
      ? Response.json(metadata) : new Response('Not found', { status: 404 }) } as Fetcher };
    const project = await ensureAccountGitSpaceProject(cloudEnv, userId, { sourceBranch: 'unrelated', sourceCommit: 'c'.repeat(40) });
    expect(project).toMatchObject({ lifecycle: 'cloud-only', baseBranch: metadata.branch, source: metadata });
    expect(await env.PROJECT_AUTHORITY.getByName(`${userId}:${project.id}`).listWorkspaces()).toEqual([]);
  });

  it('pins the selected account frontend and its source branch instead of the channel build', async () => {
    const userId = env.ACCOUNT_ID;
    const sha = 'd'.repeat(40);
    const key = `releases/${sha}/frontend`;
    const releases = env.TENANT_RELEASES.getByName(userId);
    await releases.stage({
      sha, label: 'Account frontend', workspaceId: null,
      artifacts: { worker: null, machine: null, omp: null, frontend: { key, hash: `sha256:${'a'.repeat(64)}`, size: 1 } },
      worker: null, omp: null,
    }, 'human');
    await releases.launch({ sha, targets: ['frontend'] });
    await env.DATA.put(`users/${userId}/${key}/gitspace-source.json`, JSON.stringify({ release: sha, branch: 'account/source', commit: sha }));
    const cloudEnv = { ...env, ASSETS: { fetch: async () => Response.json({ release: 'channel:other', branch: 'other', commit: 'e'.repeat(40) }) } as Fetcher };
    const project = await ensureAccountGitSpaceProject(cloudEnv, userId, { sourceBranch: 'wrong-fallback' });
    expect(project.source).toEqual({ release: sha, branch: 'account/source', commit: sha });
    expect(project.baseBranch).toBe('account/source');
  });
});
