import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ProjectAuthorityDO, UserProjectIndexDO } from '../src/project-authority.js';

const projectEnv = env as typeof env & {
  PROJECT_AUTHORITY: DurableObjectNamespace<ProjectAuthorityDO>;
  USER_PROJECTS: DurableObjectNamespace<UserProjectIndexDO>;
};

describe('ProjectAuthorityDO', () => {
  it('owns canonical project and workspace definitions with optimistic revisions', async () => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName('project-definitions');
    const project = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.bootstrap({
      id: 'project-a',
      name: 'Project A',
      repositoryReference: 'github:gitspace/project-a',
      baseBranch: 'main',
      createdBy: 'machine-a',
    }));
    expect(project).toMatchObject({ id: 'project-a', lifecycle: 'provisioning', revision: 1 });

    const workspace = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putWorkspace({
      id: 'workspace-a',
      projectId: 'project-a',
      kind: 'worktree',
      name: 'Workspace A',
      branch: 'feature/a',
      phase: 'code',
      sourceKind: 'branch',
      sourceRef: 'feature/a',
      lifecycle: 'active',
      goalId: null,
      expectedRevision: 0,
    }));
    expect(workspace).toMatchObject({ id: 'workspace-a', revision: 1, lifecycle: 'active' });
    await expect(runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putWorkspace({
      ...workspace,
      name: 'Stale update',
      expectedRevision: 0,
    }))).rejects.toThrow('Workspace revision conflict');
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.listWorkspaces()))
      .toMatchObject([{ id: 'workspace-a', name: 'Workspace A' }]);
  });

  it('persists durable operations and append-only project events', async () => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName('operations-events');
    await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.bootstrap({
      id: 'project-b', name: 'Project B', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a',
    }));
    const operation = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.createOperation({
      projectId: 'project-b',
      workspaceId: null,
      kind: 'project.create',
      targetMachines: ['machine-a'],
      steps: [{ id: 'materialize', label: 'Materialize project' }],
      createdBy: 'machine-a',
    }));
    expect(operation).toMatchObject({ state: 'queued', revision: 1, steps: [{ state: 'queued' }] });
    const running = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.updateOperation({
      id: operation.id,
      expectedRevision: 1,
      state: 'running',
      steps: operation.steps.map((step) => ({ ...step, state: 'running' as const })),
      error: null,
      claimToken: 'claim-a',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    expect(running).toMatchObject({ state: 'running', revision: 2, claimToken: 'claim-a' });

    const first = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.appendEvent({
      scope: 'project', entity: 'project', entityId: 'project-b', revision: 1, operation: 'created', payload: { name: 'Project B' },
    }));
    const second = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.appendEvent({
      scope: 'workspace', entity: 'workspace', entityId: 'workspace-b', revision: 1, operation: 'created', payload: {},
    }));
    expect(second.offset).toBe(first.offset + 1);
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.listEvents(first.offset)))
      .toMatchObject([{ offset: second.offset, entityId: 'workspace-b' }]);
  });

  it('keeps one optimistic canonical session directory per project', async () => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName('canonical-sessions');
    await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.bootstrap({
      id: 'project-c', name: 'Project C', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a',
    }));
    const session = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putCanonicalSession({
      id: 'session-a',
      workspaceId: 'workspace-c',
      ompSessionId: 'omp-session-a',
      machineId: 'machine-a',
      state: 'active',
      sessionObjectKey: 'projects/project-c/sessions/session-a.jsonl',
      sessionObjectHash: `sha256:${'a'.repeat(64)}`,
      sessionFormatVersion: 'omp-jsonl-1',
      activity: { active: true, reasons: [{ kind: 'turn' }] },
      expectedRevision: 0,
    }));
    expect(session).toMatchObject({ revision: 1, state: 'active', activity: { active: true } });
    await expect(runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putCanonicalSession({
      ...session,
      state: 'closed',
      expectedRevision: 0,
    }))).rejects.toThrow('Canonical session revision conflict');
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.listCanonicalSessions()))
      .toMatchObject([{ id: 'session-a', workspaceId: 'workspace-c', revision: 1 }]);
  });

  it('advances canonical artifact manifests without accepting stale writers', async () => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName('artifact-scopes');
    const scope = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putArtifactScope({
      id: 'space:workspace-a',
      workspaceId: 'workspace-a',
      generation: 1,
      manifestHash: `sha256:${'b'.repeat(64)}`,
      expectedGeneration: 0,
    }));
    expect(scope).toMatchObject({ generation: 1, workspaceId: 'workspace-a' });
    await expect(runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putArtifactScope({
      ...scope,
      generation: 2,
      expectedGeneration: 0,
    }))).rejects.toThrow('Artifact scope generation conflict');
  });

  it('persists canonical artifact promotion outcomes', async () => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName('artifact-promotions');
    const id = crypto.randomUUID();
    await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putArtifactPromotion({
      id,
      sourceWorkspaceId: 'workspace-a',
      sourceGeneration: 3,
      expectedBaseGeneration: 2,
      committedBaseGeneration: null,
      paths: ['apps/demo'],
      state: 'planned',
    }));
    const committed = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putArtifactPromotion({
      id,
      sourceWorkspaceId: 'workspace-a',
      sourceGeneration: 3,
      expectedBaseGeneration: 2,
      committedBaseGeneration: 3,
      paths: ['apps/demo'],
      state: 'committed',
    }));
    expect(committed).toMatchObject({ id, state: 'committed', committedBaseGeneration: 3 });
  });

  it('expires and releases hosted service route leases', async () => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName('hosted-routes');
    const now = Date.now();
    const route = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.leaseHostedRoute({
      hostname: 'app--workspace-a.example.test',
      workspaceId: 'workspace-a',
      serviceName: 'app',
      machineId: 'machine-a',
      ingress: 'http://127.0.0.1:17000',
      portName: 'http',
      port: 17_000,
      generation: 2,
      leaseExpiresAt: new Date(now + 60_000).toISOString(),
      health: 'healthy',
    }));
    expect(route).toMatchObject({ machineId: 'machine-a', generation: 2 });
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.listHostedRoutes(new Date(now + 1_000).toISOString()))).toHaveLength(1);
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.releaseHostedRoute(route.hostname, 'machine-b'))).toBe(false);
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.releaseHostedRoute(route.hostname, 'machine-a'))).toBe(true);
  });

  it('keeps deletion tombstones while removing workspace-owned authority state', async () => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName('deletions');
    const project = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.bootstrap({
      id: 'project-delete', name: 'Delete', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a',
    }));
    const workspace = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putWorkspace({
      id: 'workspace-delete', projectId: project.id, kind: 'worktree', name: 'Delete', branch: 'delete',
      phase: 'code', sourceKind: 'base', sourceRef: 'main', lifecycle: 'archived', goalId: null, expectedRevision: 0,
    }));
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.removeWorkspace(workspace.id, workspace.revision))).toBe(true);
    const tombstone = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.deleteProject(project.revision));
    expect(tombstone).toMatchObject({ id: project.id, lifecycle: 'deleting', revision: 2 });
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.listWorkspaces())).toEqual([]);
  });
});

describe('UserProjectIndexDO', () => {
  it('reserves one cloud-only source definition under concurrent repair and reuses canonical repository identity', async () => {
    const index = projectEnv.USER_PROJECTS.getByName('source-concurrent');
    const source = { release: 'channel:test', branch: 'release/test', commit: 'a'.repeat(40) };
    const ensured = await Promise.all(Array.from({ length: 8 }, () => index.ensureGitSpaceProject(source)));
    expect(new Set(ensured.map((project) => project.id)).size).toBe(1);
    expect(await index.list()).toMatchObject([{ lifecycle: 'cloud-only', role: 'gitspace-source', source }]);
    await runInDurableObject(index, (instance: UserProjectIndexDO) => {
      expect(() => instance.remove(ensured[0]!.id)).toThrow();
    });

    const adopted = projectEnv.USER_PROJECTS.getByName('source-existing');
    await adopted.put({
      id: 'existing-checkout', name: 'My renamed source', lifecycle: 'active',
      repositoryReference: 'git@github.com:inKibra/gitspace.sh.git', baseBranch: 'my-source',
      role: null, source: null, revision: 3, archivedAt: null, updatedAt: new Date(0).toISOString(),
    });
    const repaired = await adopted.ensureGitSpaceProject(source);
    expect(repaired).toMatchObject({ id: 'existing-checkout', name: 'My renamed source', role: 'gitspace-source', lifecycle: 'active', baseBranch: 'my-source' });
    expect(await adopted.list()).toHaveLength(1);
    expect(await adopted.ensureGitSpaceProject(source)).toEqual(repaired);
  });

  it('keeps canonical source workspaces intact when project deletion or archival is attempted', async () => {
    const index = projectEnv.USER_PROJECTS.getByName('source-protected');
    const project = await index.ensureGitSpaceProject({ release: null, branch: 'release/test', commit: null });
    const authority = projectEnv.PROJECT_AUTHORITY.getByName('source-protected-project');
    const source = await authority.ensureGitSpaceProject(project);
    const base = await authority.putWorkspace({
      id: source.id, projectId: source.id, kind: 'base', name: source.name, branch: source.baseBranch,
      phase: null, sourceKind: 'base', sourceRef: source.baseBranch, lifecycle: 'active', goalId: null, expectedRevision: 0,
    });
    await runInDurableObject(authority, (instance: ProjectAuthorityDO) => {
      expect(() => instance.deleteProject(source.revision)).toThrow();
      expect(() => instance.setProjectLifecycle(source.revision, 'archived')).toThrow();
    });
    expect(await authority.listWorkspaces()).toEqual([base]);
    expect(await authority.getProject()).toEqual(source);
  });

  it('fills missing release provenance once without silently repinning a reserved checkout', async () => {
    const index = projectEnv.USER_PROJECTS.getByName('source-provenance');
    const unresolved = await index.ensureGitSpaceProject({ release: null, branch: null, commit: null });
    expect(unresolved.baseBranch).toBe('HEAD');
    const pinned = await index.ensureGitSpaceProject({ release: 'channel:one', branch: 'release/one', commit: 'a'.repeat(40) });
    const repeated = await index.ensureGitSpaceProject({ release: 'channel:two', branch: 'release/two', commit: 'b'.repeat(40) });
    expect(repeated.id).toBe(unresolved.id);
    expect(repeated.source).toEqual(pinned.source);
    expect(repeated.baseBranch).toBe('release/one');
  });

  it('indexes projects and locates each workspace authority', async () => {
    const stub = projectEnv.USER_PROJECTS.getByName('user-a');
    await runInDurableObject(stub, (index: UserProjectIndexDO) => index.put({
      id: 'project-a',
      name: 'Project A',
      lifecycle: 'active',
      repositoryReference: null,
      baseBranch: 'main',
      role: null,
      source: null,
      revision: 2,
      archivedAt: null,
      updatedAt: new Date().toISOString(),
    }));
    await runInDurableObject(stub, (index: UserProjectIndexDO) => index.putWorkspaceLocation('workspace-a', 'project-a'));
    expect(await runInDurableObject(stub, (index: UserProjectIndexDO) => index.list('active')))
      .toMatchObject([{ id: 'project-a', lifecycle: 'active' }]);
    expect(await runInDurableObject(stub, (index: UserProjectIndexDO) => index.locateWorkspace('workspace-a')))
      .toBe('project-a');
  });
});
