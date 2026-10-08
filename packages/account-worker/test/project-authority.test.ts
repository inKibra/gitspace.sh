import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64, DEFAULT_INFERENCE_PROFILE_ID } from '@gitspace/protocol';
import { ProjectAuthorityDO, UserProjectIndexDO } from '../src/project-authority.js';
import { tenantRootPrivateKey } from './setup.js';
import { projectEventSchema } from '@gitspace/protocol/project-authority';
import { requireRuntimeIdentity } from '../src/runtime-access.js';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';

const projectEnv = env as typeof env & {
  PROJECT_AUTHORITY: DurableObjectNamespace<ProjectAuthorityDO>;
  USER_PROJECTS: DurableObjectNamespace<UserProjectIndexDO>;
};

async function inferenceVault() {
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({
    userId: env.ACCOUNT_ID,
    rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)),
    vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)),
  });
  await vault.ensureInference();
  return vault;
}

describe('ProjectAuthorityDO', () => {
  it('assigns new canonical projects to Default without resetting an existing profile on registration retry', async () => {
    const vault = await inferenceVault();
    const authority = projectEnv.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:inference-project`);
    const input = { id: 'inference-project', name: 'Inference', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' };
    const project = await authority.bootstrap(input);
    await projectEnv.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(project);
    const initial = await vault.ensureInference();
    expect(initial.assignments).toEqual([{ projectId: project.id, profileId: DEFAULT_INFERENCE_PROFILE_ID, revision: 0 }]);
    const created = await vault.createInferenceProfile({ name: 'Client', sourceProfileId: null });
    const profile = created.profiles.find((candidate) => candidate.id !== DEFAULT_INFERENCE_PROFILE_ID)!;
    const assigned = await vault.assignInferenceProfile({ projectId: project.id, profileId: profile.id, expectedRevision: 0 });
    expect(assigned.status).toBe('ok');
    const beforeRetry = await vault.ensureInference();

    expect(await authority.bootstrap(input)).toEqual(project);
    expect((await vault.ensureInference()).assignments).toEqual(beforeRetry.assignments);
    expect(beforeRetry.assignments).toEqual([{ projectId: project.id, profileId: profile.id, revision: 1 }]);
  });

  it('repairs an existing canonical registration whose Default assignment could not be persisted', async () => {
    const vault = await inferenceVault();
    const authority = projectEnv.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:inference-retry`);
    const input = { id: 'inference-retry', name: 'Retry', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' };
    const committed = await runInDurableObject(authority, async (_instance, state) => {
      const unavailable = new ProjectAuthorityDO(state, { ...env, CREDENTIALS: undefined } as unknown as Env);
      await state.blockConcurrencyWhile(async () => {});
      await expect(unavailable.bootstrap(input)).rejects.toThrow();
      return unavailable.getProject();
    });
    expect(committed).toMatchObject({ id: input.id, lifecycle: 'provisioning', revision: 1 });
    expect((await vault.ensureInference()).assignments).toEqual([]);

    expect(await authority.bootstrap(input)).toEqual(committed);
    expect((await vault.ensureInference()).assignments).toEqual([{ projectId: input.id, profileId: DEFAULT_INFERENCE_PROFILE_ID, revision: 0 }]);
  });

  it('keeps interrupted deletion fail-closed and retries assignment cleanup with the original revision', async () => {
    const vault = await inferenceVault();
    const authority = projectEnv.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:inference-delete`);
    const input = { id: 'inference-delete', name: 'Delete inference', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' };
    const project = await authority.bootstrap(input);
    await projectEnv.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(project);
    const created = await vault.createInferenceProfile({ name: 'Disposable', sourceProfileId: null });
    const profile = created.profiles.find((candidate) => candidate.id !== DEFAULT_INFERENCE_PROFILE_ID)!;
    await vault.assignInferenceProfile({ projectId: project.id, profileId: profile.id, expectedRevision: 0 });

    await runInDurableObject(authority, async (_instance, state) => {
      const unavailable = new ProjectAuthorityDO(state, { ...env, CREDENTIALS: undefined } as unknown as Env);
      await state.blockConcurrencyWhile(async () => {});
      await expect(unavailable.deleteProject(project.revision)).rejects.toThrow();
    });
    const tombstone = await authority.getProject();
    expect(tombstone).toMatchObject({ id: project.id, lifecycle: 'deleting', revision: project.revision + 1 });
    expect((await vault.ensureInference()).assignments).toEqual([{ projectId: project.id, profileId: profile.id, revision: 1 }]);
    await runInDurableObject(vault, async instance => {
      await expect(instance.deleteInferenceProfile({ profileId: profile.id, expectedRevision: profile.revision })).rejects.toThrow();
      await expect(instance.assignInferenceProfile({ projectId: project.id, profileId: DEFAULT_INFERENCE_PROFILE_ID, expectedRevision: 1 })).rejects.toThrow();
    });
    await runInDurableObject(authority, async instance => { await expect(instance.bootstrap(input)).rejects.toThrow(); });

    expect(await authority.deleteProject(project.revision)).toEqual(tombstone);
    expect(await authority.deleteProject(project.revision)).toEqual(tombstone);
    expect((await vault.ensureInference()).assignments).toEqual([]);
    // Late lifecycle repair or migration cannot recreate access for this identity.
    await vault.ensureProjectInference(project.id);
    expect((await vault.ensureInference()).assignments).toEqual([]);
    expect((await vault.deleteInferenceProfile({ profileId: profile.id, expectedRevision: profile.revision })).status).toBe('ok');
    expect((await vault.ensureInference()).profiles.map((candidate) => candidate.id)).toEqual([DEFAULT_INFERENCE_PROFILE_ID]);
  });

  it('routes deleting lifecycle transitions through canonical assignment cleanup', async () => {
    const vault = await inferenceVault();
    const authority = projectEnv.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:inference-lifecycle`);
    const project = await authority.bootstrap({ id: 'inference-lifecycle', name: 'Lifecycle', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
    await authority.setProjectLifecycle(project.revision, 'deleting');
    expect((await vault.ensureInference()).assignments).toEqual([]);
    await runInDurableObject(authority, async instance => { await expect(instance.setProjectLifecycle(project.revision + 1, 'active')).rejects.toThrow(); });
  });

  it('changes an active project base branch only at its current revision and never for the built-in source', async () => {
    const authority = projectEnv.PROJECT_AUTHORITY.getByName('base-branch');
    const project = await authority.bootstrap({ id: 'base-branch', name: 'Base branch', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
    await expect(runInDurableObject(authority, (instance: ProjectAuthorityDO) => instance.setBaseBranch(project.revision, 'release'))).rejects.toThrow('must be active');
    const active = await authority.setProjectLifecycle(project.revision, 'active');
    await expect(runInDurableObject(authority, (instance: ProjectAuthorityDO) => instance.setBaseBranch(project.revision, 'release'))).rejects.toThrow('revision conflict');
    expect(await authority.getProject()).toEqual(active);
    expect(await authority.setBaseBranch(active.revision, 'release')).toMatchObject({ baseBranch: 'release', revision: active.revision + 1 });

    const reserved = await projectEnv.USER_PROJECTS.getByName('base-branch-source').ensureGitSpaceProject({ release: null, branch: 'release/test', commit: null });
    const sourceAuthority = projectEnv.PROJECT_AUTHORITY.getByName('base-branch-source-project');
    const source = await sourceAuthority.setProjectLifecycle((await sourceAuthority.ensureGitSpaceProject(reserved)).revision, 'active');
    await expect(runInDurableObject(sourceAuthority, (instance: ProjectAuthorityDO) => instance.setBaseBranch(source.revision, 'main'))).rejects.toThrow('managed by GitSpace releases');
    expect(await sourceAuthority.getProject()).toEqual(source);
  });

  it('rejects stale bootstrap and workspace publication until an archived project is explicitly restored', async () => {
    const authority = projectEnv.PROJECT_AUTHORITY.getByName('archived-bootstrap');
    const input = { id: 'archived-bootstrap', name: 'Archived', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' };
    const project = await authority.bootstrap(input);
    const archived = await authority.setProjectLifecycle(project.revision, 'archived');
    await expect(runInDurableObject(authority, (instance: ProjectAuthorityDO) => instance.bootstrap(input))).rejects.toThrow();
    await expect(runInDurableObject(authority, (instance: ProjectAuthorityDO) => instance.putWorkspace({
      id: 'stale-workspace', projectId: project.id, kind: 'worktree', name: 'Stale', branch: 'feature',
      phase: 'code', sourceKind: 'branch', sourceRef: 'feature', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0,
    }))).rejects.toThrow();
    expect(await authority.getProject()).toEqual(archived);
    expect(await authority.listWorkspaces()).toEqual([]);
    const restored = await authority.setProjectLifecycle(archived.revision, 'active');
    expect(await authority.bootstrap(input)).toEqual(restored);
  });

  it('keeps a deleted project absent when a pre-delete bootstrap reply reaches the directory late', async () => {
    const authority = projectEnv.PROJECT_AUTHORITY.getByName('deleted-bootstrap');
    const index = projectEnv.USER_PROJECTS.getByName('deleted-bootstrap');
    const input = { id: 'deleted-bootstrap', name: 'Deleted', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' };
    const delayedBootstrap = await authority.bootstrap(input);
    await index.put(delayedBootstrap);
    await index.putWorkspaceLocation('deleted-workspace', input.id);
    const deleted = await authority.deleteProject(delayedBootstrap.revision);
    await index.remove(input.id);
    await expect(runInDurableObject(index, (instance: UserProjectIndexDO) => instance.put(delayedBootstrap))).rejects.toThrow();
    await expect(runInDurableObject(index, (instance: UserProjectIndexDO) => instance.put(deleted))).rejects.toThrow();
    await expect(runInDurableObject(index, (instance: UserProjectIndexDO) => instance.putWorkspaceLocation('deleted-workspace', input.id))).rejects.toThrow();
    await expect(runInDurableObject(authority, (instance: ProjectAuthorityDO) => instance.bootstrap(input))).rejects.toThrow();
    await expect(runInDurableObject(authority, (instance: ProjectAuthorityDO) => instance.setProjectLifecycle(deleted.revision, 'active'))).rejects.toThrow();
    expect(await index.list()).toEqual([]);
    expect(await index.locateWorkspace('deleted-workspace')).toBeNull();
    expect(await authority.getProject()).toEqual(deleted);
    const replacement = await projectEnv.PROJECT_AUTHORITY.getByName('replacement-project').bootstrap({ ...input, id: 'replacement-project' });
    await index.put(replacement);
    expect(await index.list()).toEqual([expect.objectContaining({ id: replacement.id })]);
  });

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
      sourceCommit: 'a'.repeat(40),
      lifecycle: 'active',
      goalId: null,
      expectedRevision: 0,
    }));
    expect(workspace).toMatchObject({ id: 'workspace-a', revision: 1, lifecycle: 'active' });
    await expect(runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putWorkspace({
      ...workspace,
      name: 'Stale update',
      expectedRevision: 0,
    }))).rejects.toThrow();
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.listWorkspaces()))
      .toMatchObject([{ id: 'workspace-a', name: 'Workspace A' }]);
    let retained = workspace;
    for (const lifecycle of ['archived', 'active'] as const) {
      retained = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putWorkspace({
        ...retained, name: 'Renamed workspace', branch: 'renamed', phase: 'review', lifecycle, expectedRevision: retained.revision,
      }));
      expect(retained).toMatchObject({ sourceCommit: workspace.sourceCommit, sourceKind: 'branch', sourceRef: 'feature/a', lifecycle });
    }
    for (const sourceCommit of ['b'.repeat(40), null, undefined]) {
      await expect(runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putWorkspace({
        ...retained, sourceCommit, name: 'Invalid mutation', expectedRevision: retained.revision,
      } as Parameters<ProjectAuthorityDO['putWorkspace']>[0]))).rejects.toThrow('immutable');
      expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.listWorkspaces())).toEqual([retained]);
    }
  });

  it('keeps legacy stored provenance unknown through canonical updates even when sourceRef looks like a commit', async () => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName('legacy-workspace-provenance');
    const [legacy] = await runInDurableObject(stub, async (authority: ProjectAuthorityDO, state) => {
      await authority.bootstrap({ id: 'legacy-project', name: 'Legacy', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
      state.storage.sql.exec(
        `INSERT INTO workspaces(workspace_id,project_id,kind,name,branch,phase,source_kind,source_ref,lifecycle,goal_id,revision,archived_at,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        'legacy-workspace', 'legacy-project', 'worktree', 'Legacy', 'feature', 'code', 'commit', 'c'.repeat(40),
        'active', null, 1, null, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z',
      );
      return authority.listWorkspaces();
    });
    expect(legacy).toMatchObject({ sourceCommit: null, sourceKind: 'commit', sourceRef: 'c'.repeat(40) });
    const updated = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putWorkspace({
      ...legacy!, phase: 'review', lifecycle: 'archived', expectedRevision: legacy!.revision,
    }));
    expect(updated).toMatchObject({ sourceCommit: null, sourceKind: 'commit', sourceRef: 'c'.repeat(40), lifecycle: 'archived' });
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.listWorkspaces())).toEqual([updated]);
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

    const first = projectEventSchema.parse(await (await stub.appendEvent({
      eventId: 'project-created',
      scope: 'project', entity: 'project', entityId: 'project-b', revision: 1, operation: 'created', payload: { name: 'Project B' },
    })).json());
    const second = projectEventSchema.parse(await (await stub.appendEvent({
      eventId: 'workspace-created',
      scope: 'workspace', entity: 'workspace', entityId: 'workspace-b', revision: 1, operation: 'created', payload: {},
    })).json());
    expect(second.offset).toBe(first.offset + 1);
    expect(await (await stub.listEvents(first.offset)).json())
      .toMatchObject([{ offset: second.offset, entityId: 'workspace-b' }]);
    const retried = projectEventSchema.parse(await (await stub.appendEvent({
      eventId: 'workspace-created', scope: 'workspace', entity: 'workspace', entityId: 'workspace-b', revision: 1, operation: 'created', payload: {},
    })).json());
    expect(retried).toEqual(second);
    expect(await (await stub.listEvents(second.offset)).json()).toEqual([]);
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
      health: { revision: 0, issues: {} },
      expectedRevision: 0,
    }));
    expect(session).toMatchObject({ revision: 1, state: 'active', activity: { active: true } });
    await expect(runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putCanonicalSession({
      ...session,
      state: 'closed',
      expectedRevision: 0,
    }))).rejects.toThrow();
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.listCanonicalSessions()))
      .toMatchObject([{ id: 'session-a', workspaceId: 'workspace-c', revision: 1 }]);
  });

  it.each([false, true])('scopes canonical conversation 1 to each space across cold starts (legacy=%s)', async legacy => {
    const projectId = `session-scope-${legacy}`;
    const stub = projectEnv.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
    await stub.bootstrap({ id: projectId, name: 'Session scopes', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
    const spaces = [projectId, `${projectId}-a`, `${projectId}-b`];
    for (const id of spaces.slice(1)) {
      await stub.putWorkspace({ id, projectId, kind: 'worktree', name: id, branch: id, phase: 'code', sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    }
    await runInDurableObject(stub, async (authority, state) => {
      if (legacy) {
        state.storage.sql.exec(`DROP TABLE canonical_sessions;
          CREATE TABLE canonical_sessions(
            session_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL UNIQUE, omp_session_id TEXT NOT NULL UNIQUE,
            machine_id TEXT, state TEXT NOT NULL, session_object_key TEXT, session_object_hash TEXT,
            session_format_version TEXT, activity_json TEXT NOT NULL, health_json TEXT NOT NULL,
            revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
          );`);
      }
      const initial = authority.putCanonicalSession({
        id: `session-${projectId}`, workspaceId: projectId, ompSessionId: '1', machineId: 'machine-a',
        state: 'active', sessionObjectKey: 'retained/session.jsonl', sessionObjectHash: `sha256:${'b'.repeat(64)}`,
        sessionFormatVersion: 'omp-jsonl-1', activity: { active: true, reasons: [{ kind: 'turn' }] },
        health: { revision: 3, issues: {} }, expectedRevision: 0,
      });
      const retained = authority.putCanonicalSession({ ...initial, id: `session-${projectId}-a`, workspaceId: `${projectId}-a`, ompSessionId: '2', machineId: null, state: 'closed', expectedRevision: 0 });
      await authority.alarm();
      let reopened = new ProjectAuthorityDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      expect(reopened.getCanonicalSession(initial.id)).toEqual(initial);
      expect(reopened.getCanonicalSession(retained.id)).toEqual(retained);
      for (const workspaceId of spaces.slice(1)) {
        const existing = reopened.getCanonicalSession(`session-${workspaceId}`);
        reopened.putCanonicalSession({ ...initial, id: `session-${workspaceId}`, workspaceId, expectedRevision: existing?.revision ?? 0 });
      }
      const beforeReopen = reopened.listCanonicalSessions();
      expect(beforeReopen.map(session => session.workspaceId).sort()).toEqual([...spaces].sort());
      expect(beforeReopen.map(session => session.ompSessionId)).toEqual(['1', '1', '1']);
      expect(() => reopened.putCanonicalSession({ ...initial, id: 'duplicate-space', ompSessionId: '2', expectedRevision: 0 })).toThrow();
      await reopened.alarm();
      reopened = new ProjectAuthorityDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      expect(reopened.listCanonicalSessions()).toEqual(beforeReopen);
      const updated = reopened.putCanonicalSession({ ...initial, state: 'closed', expectedRevision: initial.revision });
      expect(updated).toEqual({ ...initial, state: 'closed', revision: initial.revision + 1, updatedAt: updated.updatedAt });
      expect(() => reopened.putCanonicalSession({ ...initial, id: 'duplicate-after-reopen', ompSessionId: '3', expectedRevision: 0 })).toThrow();
      await reopened.alarm();
    });
  });

  it.each(['cloud-only', 'provisioning', 'active', 'archiving', 'archived', 'restoring', 'failed', 'deleting'] as const)(
    'bounds runtime writes by project lifecycle %s', async lifecycle => {
      const projectId = `runtime-project-${lifecycle}`;
      const stub = projectEnv.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
      const project = await stub.bootstrap({ id: projectId, name: 'Runtime access', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
      await stub.setProjectLifecycle(project.revision, lifecycle);
      const identity = RuntimeIdentitySchema.parse({ projectId, workspaceId: projectId });
      if (['cloud-only', 'provisioning', 'active'].includes(lifecycle)) {
        expect((await requireRuntimeIdentity(env, env.ACCOUNT_ID, identity, true)).project.lifecycle).toBe(lifecycle);
      } else {
        await expect(requireRuntimeIdentity(env, env.ACCOUNT_ID, identity, true)).rejects.toThrow();
      }
      if (lifecycle === 'deleting') await expect(requireRuntimeIdentity(env, env.ACCOUNT_ID, identity, false)).rejects.toThrow();
      else expect((await requireRuntimeIdentity(env, env.ACCOUNT_ID, identity, false)).project.lifecycle).toBe(lifecycle);
    },
  );

  it.each(['archiving', 'archived', 'deleting'] as const)('keeps %s workspace runtime writes disabled', async lifecycle => {
    const projectId = `runtime-workspace-${lifecycle}`;
    const stub = projectEnv.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
    const project = await stub.bootstrap({ id: projectId, name: 'Runtime workspace', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
    await stub.setProjectLifecycle(project.revision, 'active');
    const workspaceId = `${projectId}-branch`;
    await stub.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: workspaceId, branch: 'feature', phase: 'code', sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle, goalId: null, expectedRevision: 0 });
    const identity = RuntimeIdentitySchema.parse({ projectId, workspaceId });
    await expect(requireRuntimeIdentity(env, env.ACCOUNT_ID, identity, true)).rejects.toThrow();
    if (lifecycle === 'deleting') await expect(requireRuntimeIdentity(env, env.ACCOUNT_ID, identity, false)).rejects.toThrow();
    else expect((await requireRuntimeIdentity(env, env.ACCOUNT_ID, identity, false)).workspace?.lifecycle).toBe(lifecycle);
  });

  it('advances canonical artifact manifests without accepting stale writers', async () => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName('artifact-scopes');
    await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.bootstrap({
      id: 'project-artifacts', name: 'Artifacts', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a',
    }));
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
    }))).rejects.toThrow();
  });

  it('persists canonical artifact promotion outcomes', async () => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName('artifact-promotions');
    await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.bootstrap({
      id: 'project-promotions', name: 'Promotions', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a',
    }));
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
    await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.bootstrap({
      id: 'project-routes', name: 'Routes', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a',
    }));
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
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.releaseHostedRoute(route.hostname, 'machine-b', route.generation))).toBe(false);
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.releaseHostedRoute(route.hostname, 'machine-a', route.generation))).toBe(true);
  });

  it.each(['foreign machine', 'stale generation'])('fences hosted route lease from %s', async (kind) => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName(`lease-fence-${kind}`);
    await stub.bootstrap({ id: `lease-fence-${kind}`, name: 'Routes', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
    const route = await stub.leaseHostedRoute({ hostname: 'app--workspace--test-srv.gssh.dev', workspaceId: 'workspace', serviceName: 'app', machineId: 'machine-a', ingress: 'http://127.0.0.1:17000', portName: 'http', port: 17000, generation: 2, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'healthy' });
    await runInDurableObject(stub, (authority: ProjectAuthorityDO) => {
      expect(() => authority.leaseHostedRoute({ ...route, machineId: kind === 'foreign machine' ? 'machine-b' : 'machine-a', generation: kind === 'stale generation' ? 1 : 3 })).toThrow();
    });
    expect(await stub.listHostedRoutes()).toEqual([route]);
  });

  it('fences stale release from newer owner generation', async () => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName('release-fence');
    await stub.bootstrap({ id: 'release-fence', name: 'Routes', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
    const route = await stub.leaseHostedRoute({ hostname: 'app--workspace--test-srv.gssh.dev', workspaceId: 'workspace', serviceName: 'app', machineId: 'machine-a', ingress: 'http://127.0.0.1:17000', portName: 'http', port: 17000, generation: 2, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), health: 'healthy' });
    const released = await stub.releaseHostedRoute(route.hostname, 'machine-a', 1);
    expect(released).toBe(false);
    expect(await stub.listHostedRoutes()).toEqual([route]);
  });

  it('keeps deletion tombstones while removing workspace-owned authority state', async () => {
    const stub = projectEnv.PROJECT_AUTHORITY.getByName('deletions');
    const project = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.bootstrap({
      id: 'project-delete', name: 'Delete', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a',
    }));
    const workspace = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putWorkspace({
      id: 'workspace-delete', projectId: project.id, kind: 'worktree', name: 'Delete', branch: 'delete',
      phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'archived', goalId: null, expectedRevision: 0,
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
      phase: null, sourceKind: 'base', sourceRef: source.baseBranch, sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0,
    });
    await runInDurableObject(authority, async (instance: ProjectAuthorityDO) => {
      await expect(instance.deleteProject(source.revision)).rejects.toThrow();
      await expect(instance.setProjectLifecycle(source.revision, 'archived')).rejects.toThrow();
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
