import { env } from 'cloudflare:test';
import { ArtifactsCodeStore, ProjectImportRequiresMachineError } from '@gitspace/runtime-workspace-do';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeWorkspaceCodeRef } from '../src/account-runtime-host.js';

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
    [Symbol.dispose]() {}, createToken: unsupported, listTokens: unsupported, fork: unsupported, readBlob: unsupported, readTree: unsupported, readCommit: unsupported, readFile: unsupported,
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
    ['REMOTE_AUTH_REQUIRED', 10106, 'private', "This is a private repository, so GitSpace Cloud can't import it. Open the project on a connected machine to do the initial import."],
    ['MEMORY_LIMIT', 10402, 'too-large', "This repository is larger than Cloudflare Artifacts' 40 MB import limit. Open the project on a connected machine to do the initial import."],
  ])('asks for a machine import when Artifacts refuses with %s', async (code, numericCode, reason, message) => {
    const artifacts = namespace({ importError: artifactsError(code, numericCode, 'Repository at "https://github.com/example/repository.git" was refused.') });
    const imported = artifacts.code.importProject(projectId, origin);
    await expect(imported).rejects.toBeInstanceOf(ProjectImportRequiresMachineError);
    await expect(imported).rejects.toMatchObject({ _tag: 'ProjectImportRequiresMachineError', reason, message });
  });

  it('propagates other import failures unchanged', async () => {
    const unavailable = artifactsError('UPSTREAM_UNAVAILABLE', 10107, 'Remote unavailable');
    await expect(namespace({ importError: unavailable }).code.importProject(projectId, origin)).rejects.toBe(unavailable);
  });

  it('reports a machine-seeded repository as pending until its base branch exists', async () => {
    const artifacts = namespace({ repositories: ['project-imported'] });
    const pending = artifacts.code.importProject(projectId, origin);
    await expect(pending).rejects.toMatchObject({ reason: 'pending', message: "The initial import from a machine hasn't finished yet. Keep the project open on the machine and try again." });
    artifacts.refs.add('main');
    await expect(artifacts.code.importProject(projectId, origin)).resolves.toEqual(info);
    expect(artifacts.calls).toEqual([]);
  });

  it('keeps a completed import usable after the project base branch changes', async () => {
    const artifacts = namespace({ repositories: ['project-imported'], refs: ['HEAD'] });
    await expect(artifacts.code.importProject(projectId, { ...origin, branch: 'release' })).resolves.toEqual(info);
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
});

describe('runtime workspace code ref', () => {
  it('retries a failed repository preparation instead of caching the rejection', async () => {
    const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
    await project.bootstrap({ id: projectId, name: 'Imported', repositoryReference: origin.url, baseBranch: 'main', createdBy: 'machine' });
    await project.putWorkspace({ id: 'imported-feature', projectId, kind: 'worktree', name: 'Feature', branch: 'feature', phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    const importProject = vi.spyOn(ArtifactsCodeStore.prototype, 'importProject')
      .mockRejectedValueOnce(new ProjectImportRequiresMachineError('pending'))
      .mockResolvedValue(info);
    vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(info);
    const ref = runtimeWorkspaceCodeRef(env, RuntimeIdentitySchema.parse({ projectId, workspaceId: 'imported-feature' }));
    await expect(ref()).rejects.toThrow("The initial import from a machine hasn't finished yet.");
    await expect(ref()).resolves.toBe('refs/heads/feature');
    await expect(ref()).resolves.toBe('refs/heads/feature');
    expect(importProject).toHaveBeenCalledTimes(2);
  });
});
