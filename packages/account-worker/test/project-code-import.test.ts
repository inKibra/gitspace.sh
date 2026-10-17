import { env } from 'cloudflare:test';
import { ArtifactsCodeStore, ProjectImportRequiresMachineError, type GitHttpAuth } from '@gitspace/runtime-workspace-do';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeWorkspaceCodeRef } from '../src/account-runtime-host.js';
import { network } from './network.js';

afterEach(() => vi.restoreAllMocks());

const projectId = 'imported';
const origin = { url: 'https://github.com/example/repository.git', branch: 'main' };
const info: ArtifactsRepoInfo = { id: 'project-imported', name: 'project-imported', description: null, defaultBranch: 'main', createdAt: '', updatedAt: '', lastPushAt: null, source: null, readOnly: false, remote: 'https://artifacts.invalid/project-imported.git' };
const commit: ArtifactsCommitMetadata = { hash: 'a'.repeat(40), treeHash: 'b'.repeat(40), parents: [], message: 'seed', author: { name: 'Fixture', email: 'fixture@example.invalid' }, committer: { name: 'Fixture', email: 'fixture@example.invalid' }, authoredAt: 1, committedAt: 1 };

function artifactsError(code: string, numericCode: number, message: string) {
  return Object.assign(new Error(message), { name: 'ArtifactsError', code, numericCode });
}

/** An Artifacts namespace whose repositories resolve only the refs listed in `refs` ('HEAD' is the default branch). */
function namespace(options: { repositories?: string[]; refs?: string[]; importError?: Error; createError?: Error } = {}) {
  const repositories = new Set(options.repositories);
  const refs = new Set(options.refs);
  const calls: string[] = [];
  const created = { ...info, token: 'initial-token', tokenExpiresAt: '' };
  const unsupported = async (): Promise<never> => { throw new Error('Unexpected repository operation'); };
  const repo: ArtifactsRepo = {
    [Symbol.dispose]() {}, listTokens: unsupported, fork: unsupported, readBlob: unsupported, readTree: unsupported, readCommit: unsupported, readFile: unsupported,
    createToken: async scope => ({ id: `lease-${scope}`, plaintext: 'artifacts-lease', scope: scope ?? 'write', expiresAt: '' }),
    info: async () => info,
    revokeToken: async token => { calls.push(`revoke ${token}`); return true; },
    log: async query => refs.has(query?.ref ?? 'HEAD') ? [commit] : [],
  };
  const binding: Artifacts = {
    list: async () => ({ repos: [...repositories].map(name => ({ ...info, name })), total: repositories.size }),
    get: async () => repo,
    import: async ({ target }) => {
      calls.push(`import ${target.name}`);
      if (options.importError) throw options.importError;
      repositories.add(target.name);
      return created;
    },
    create: async (name, opts) => {
      calls.push(`create ${name} ${JSON.stringify(opts)}`);
      if (options.createError) throw options.createError;
      repositories.add(name);
      return created;
    },
    delete: unsupported,
  };
  return { code: new ArtifactsCodeStore(binding), calls, refs };
}

describe('project import classification', () => {
  it.each([
    ['REMOTE_AUTH_REQUIRED', 10106, 'private'],
    ['MEMORY_LIMIT', 10402, 'too-large'],
  ])('asks for a machine import when Artifacts refuses with %s', async (code, numericCode, reason) => {
    const artifacts = namespace({ importError: artifactsError(code, numericCode, 'Repository at "https://github.com/example/repository.git" was refused.') });
    const imported = artifacts.code.importProject(projectId, origin, null);
    await expect(imported).rejects.toBeInstanceOf(ProjectImportRequiresMachineError);
    await expect(imported).rejects.toMatchObject({ _tag: 'ProjectImportRequiresMachineError', reason });
  });

  it('propagates other import failures unchanged', async () => {
    const unavailable = artifactsError('UPSTREAM_UNAVAILABLE', 10107, 'Remote unavailable');
    await expect(namespace({ importError: unavailable }).code.importProject(projectId, origin, null)).rejects.toBe(unavailable);
  });

  it('reports a machine-seeded repository as pending until its base branch exists', async () => {
    const artifacts = namespace({ repositories: ['project-imported'] });
    const pending = artifacts.code.importProject(projectId, origin, null);
    await expect(pending).rejects.toMatchObject({ reason: 'pending' });
    artifacts.refs.add('main');
    await expect(artifacts.code.importProject(projectId, origin, null)).resolves.toEqual(info);
    expect(artifacts.calls).toEqual([]);
  });

  it('keeps a completed import usable after the project base branch changes', async () => {
    const artifacts = namespace({ repositories: ['project-imported'], refs: ['HEAD'] });
    await expect(artifacts.code.importProject(projectId, { ...origin, branch: 'release' }, null)).resolves.toEqual(info);
    expect(artifacts.calls).toEqual([]);
  });

  it('creates the machine seed target empty, without importing, and revokes its initial token', async () => {
    const artifacts = namespace();
    await expect(artifacts.code.ensureMachineSeedTarget(projectId, 'trunk')).resolves.toEqual(info);
    await expect(artifacts.code.ensureMachineSeedTarget(projectId, 'trunk')).resolves.toEqual(info);
    expect(artifacts.calls).toEqual([
      `create project-imported ${JSON.stringify({ setDefaultBranch: 'trunk', readOnly: false, description: 'GitSpace machine-seeded project imported (trunk)' })}`,
      'revoke initial-token',
    ]);
  });

  it('adopts a seed target another request created concurrently', async () => {
    const artifacts = namespace({ createError: artifactsError('ALREADY_EXISTS', 10001, 'Repository already exists') });
    await expect(artifacts.code.ensureMachineSeedTarget(projectId, 'trunk')).resolves.toEqual(info);
    expect(artifacts.calls).toHaveLength(1);
  });

  it('imports a covered repository over authenticated smart HTTP, never through the native import', async () => {
    const artifacts = namespace();
    const head = 'c'.repeat(40);
    const zero = '0'.repeat(40);
    const packet = (line: string) => (line.length + 4).toString(16).padStart(4, '0') + line;
    const pack = new Uint8Array([...new TextEncoder().encode('PACK'), 0, 0, 0, 2, 0, 0, 0, 0, ...new Uint8Array(20).fill(3)]);
    const requests: string[] = [];
    let pushed = '';
    network.use(
      http.get(`${origin.url}/info/refs`, ({ request }) => {
        requests.push(`origin discovery ${request.headers.get('authorization')}`);
        return new HttpResponse(packet('# service=git-upload-pack\n') + '0000' + packet('version 2\n') + packet('ls-refs\n') + packet('fetch=shallow\n') + '0000');
      }),
      http.post(`${origin.url}/git-upload-pack`, async ({ request }) => {
        const body = await request.text();
        requests.push(`origin ${body.includes('command=ls-refs') ? 'refs' : 'pack'} ${request.headers.get('authorization')}`);
        if (body.includes('command=ls-refs')) return new HttpResponse(packet(`${head} refs/heads/main\n`) + '0000');
        return new HttpResponse(new Blob([packet('packfile\n'), new TextEncoder().encode((pack.length + 5).toString(16).padStart(4, '0')), new Uint8Array([1]), pack, '0000']));
      }),
      http.get(`${info.remote}/info/refs`, ({ request }) => new HttpResponse(new URL(request.url).searchParams.get('service') === 'git-receive-pack'
        ? packet(`${zero} capabilities^{}\0report-status\n`) + '0000'
        : packet('# service=git-upload-pack\n') + '0000' + '0000')),
      http.post(`${info.remote}/git-receive-pack`, async ({ request }) => {
        expect(request.headers.get('authorization')).toBe('Bearer artifacts-lease');
        pushed = new TextDecoder().decode(await request.arrayBuffer());
        return new HttpResponse(packet('unpack ok\n') + packet('ok refs/heads/main\n') + '0000');
      }),
    );
    const credentials = async (): Promise<GitHttpAuth> => ({ kind: 'basic', username: 'x-access-token', password: 'ghs_covered' });
    await expect(artifacts.code.importProject(projectId, origin, credentials)).resolves.toEqual(info);
    const basic = `Basic ${btoa('x-access-token:ghs_covered')}`;
    expect(requests).toEqual([`origin discovery ${basic}`, `origin refs ${basic}`, `origin discovery ${basic}`, `origin pack ${basic}`]);
    expect(pushed).toContain(`${zero} ${head} refs/heads/main\0report-status\n`);
    expect(artifacts.calls).toEqual([
      `create project-imported ${JSON.stringify({ setDefaultBranch: 'main', readOnly: false, description: 'GitSpace authenticated import of project imported (main)' })}`,
      'revoke initial-token',
      'revoke lease-write',
    ]);
  });
});

describe('runtime workspace code ref', () => {
  it.each(['private', 'too-large', 'pending'] as const)('allows machine remediation after %s instead of permanently caching the refusal', async reason => {
    const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
    await project.bootstrap({ id: projectId, name: 'Imported', repositoryReference: origin.url, baseBranch: 'main', createdBy: 'machine' });
    await project.putWorkspace({ id: 'imported-feature', projectId, kind: 'worktree', name: 'Feature', branch: 'feature', phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    const importProject = vi.spyOn(ArtifactsCodeStore.prototype, 'importProject')
      .mockRejectedValueOnce(new ProjectImportRequiresMachineError(reason))
      .mockResolvedValue(info);
    const forkWorkspace = vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(info);
    const ref = runtimeWorkspaceCodeRef(env, RuntimeIdentitySchema.parse({ projectId, workspaceId: 'imported-feature' }), () => 'feature');
    await expect(ref()).rejects.toMatchObject({ reason });
    expect(forkWorkspace).not.toHaveBeenCalled();
    await expect(ref()).resolves.toBe('refs/heads/feature');
    await expect(ref()).resolves.toBe('refs/heads/feature');
    expect(importProject).toHaveBeenCalledTimes(2);
  });
});
