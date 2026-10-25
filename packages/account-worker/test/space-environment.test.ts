import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { EnvironmentError, approvedBrowserOrigins, approvedBrowserSites, browserOriginHash, type LifecycleActor, type LifecycleMutation, type LifecycleState } from '@gitspace/protocol-environment';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { SpaceEnvironmentStore } from '../src/space-environment.js';
import { LiveChanges } from '../src/live-changes.js';
import * as committedOrigins from '../src/committed-browser-origins.js';

const hash = `sha256:${'a'.repeat(64)}`;
const machine = { actorId: 'machine-a', machineId: 'machine-a', kind: 'machine' as const, lifecycleControl: false };
const human = { actorId: 'browser', machineId: 'browser', kind: 'browser' as const, lifecycleControl: true };
type Origin = LifecycleState['browserOrigins'][number];

/** A project whose base workspace is the project id; `id(name)` names its other workspaces. */
async function project() {
  const projectId = `project-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await authority.bootstrap({ id: projectId, name: 'Project', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
  await runInDurableObject(authority, instance => { instance.ensureBaseWorkspace({ userId: env.ACCOUNT_ID, projectId }); });
  const id = (name: string) => name === 'project' ? projectId : `${projectId}-${name}`;
  const created = new Set<string>();
  const space = async (name: string) => {
    if (name !== 'project' && !created.has(name)) {
      created.add(name);
      await authority.putWorkspace({ id: id(name), projectId, kind: 'worktree', name, branch: name, phase: null, sourceKind: 'branch', sourceRef: name, sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    }
    return { stub: env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${id(name)}`), identity: { projectId, workspaceId: id(name) } };
  };
  const mutate = async (name: string, input: LifecycleMutation, actor: LifecycleActor = machine) => {
    const { stub, identity } = await space(name);
    const result = await stub.mutateLifecycleState(identity, input, actor);
    if (result.status === 'error') throw new EnvironmentError(result.failure.code, result.failure.message, result.failure.context);
    return result.state;
  };
  const get = async (name: string) => {
    const { stub, identity } = await space(name);
    return stub.getLifecycleState(identity);
  };
  /** Trusted ingress, as a committed refresh applies it. */
  const setOrigins = async (name: string, origins: Origin[]) => {
    const { stub, identity } = await space(name);
    await stub.getLifecycleState(identity);
    const shared = await authority.environmentShared();
    const result = await runInDurableObject(stub, (_instance, context) => new SpaceEnvironmentStore(context.storage, new LiveChanges(context.storage, () => {})).setBrowserOrigins(projectId, identity.workspaceId, origins, shared));
    if (result.shared) await authority.applyEnvironmentShared(result.shared);
  };
  await mutate('workspace', { op: 'configure', bundleJson: JSON.stringify({ version: 1, profiles: { base: {} } }), executions: [{ id: 'prepare', kind: 'script', phase: 'machine/prepare', label: 'Prepare', command: '01-prepare.sh', fileName: '01-prepare.sh', content: 'echo prepare', hash }] });
  await mutate('workspace', { op: 'approval', scope: 'project', executionHash: hash, approved: true }, human);
  return { projectId, authority, space, mutate, get, setOrigins };
}
const claim = (runId: string): LifecycleMutation => ({ op: 'claim', runId, phase: 'machine/prepare', profile: 'base', executionHashes: [hash], generation: 1, rerun: false });

describe('workspace environment', () => {
  for (const scope of ['project', 'workspace'] as const) it(`retains ${scope} browser approval across failed committed refresh without granting stale origins`, async () => {
    const p = await project();
    const { stub, identity } = await p.space(scope === 'project' ? 'project' : 'workspace');
    const origin = { pattern: 'example.com', hash: await browserOriginHash('example.com') };
    await runInDurableObject(stub, async (instance, context) => {
      const repository = { id: 'repo', name: 'repo', description: null, defaultBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastPushAt: null, source: null, readOnly: false, remote: 'https://example.com/repo.git' };
      const initialize = vi.spyOn(ArtifactsCodeStore.prototype, 'ensureEmptyProject').mockResolvedValue(repository);
      const fork = vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(repository);
      const committed = vi.spyOn(committedOrigins, 'committedBrowserOrigins').mockResolvedValue({ commit: 'a'.repeat(40), origins: [origin] });
      // Stubs are per object context: this one is used from inside the workspace object.
      const projectAuthority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${p.projectId}`);
      const stored = async () => new SpaceEnvironmentStore(context.storage, new LiveChanges(context.storage, () => {})).get(p.projectId, identity.workspaceId, await projectAuthority.environmentShared()).approvals;
      try {
        await instance.refreshBrowserOrigins(identity);
        expect(await instance.mutateLifecycleState(identity, { op: 'approval', scope, executionHash: origin.hash, approved: true }, human)).toMatchObject({ status: 'ok' });
        const approvals = await stored();
        committed.mockRejectedValueOnce(new Error('Committed repository unavailable'));
        await expect(instance.refreshBrowserOrigins(identity)).rejects.toThrow('Committed repository unavailable');
        expect(await stored()).toEqual(approvals);
        expect(approvedBrowserOrigins(await instance.getLifecycleState(identity))).toEqual([]);
        expect(await instance.mutateLifecycleState(identity, { op: 'approval', scope, executionHash: origin.hash, approved: true }, human)).toMatchObject({ status: 'error', failure: { code: 'ContentChanged' } });
        // Other environment writes and shared value changes cannot restore stale content.
        await instance.mutateLifecycleState(identity, { op: 'policy', automatic: true }, human);
        await projectAuthority.setEnvironmentValue('RETAINED', 'yes');
        expect(approvedBrowserOrigins(await instance.getLifecycleState(identity))).toEqual([]);
        expect(approvedBrowserOrigins((await instance.refreshBrowserOrigins(identity)).state)).toEqual(['example.com']);
        expect(await stored()).toEqual(approvals);
        // Only a successful committed removal prunes the retained observation.
        committed.mockRejectedValueOnce(new Error('Committed repository unavailable'));
        await expect(instance.refreshBrowserOrigins(identity)).rejects.toThrow('Committed repository unavailable');
        committed.mockResolvedValueOnce({ commit: 'b'.repeat(40), origins: [] });
        expect(approvedBrowserOrigins((await instance.refreshBrowserOrigins(identity)).state)).toEqual([]);
        expect(approvedBrowserOrigins((await instance.refreshBrowserOrigins(identity)).state)).toEqual([]);
        expect((await stored()).some(entry => entry.executionHash === origin.hash)).toBe(false);
      } finally {
        committed.mockRestore(); fork.mockRestore(); initialize.mockRestore();
      }
    });
  });

  it('inherits base approvals only where the committed workspace declares the origin', async () => {
    const p = await project();
    const shared = { pattern: 'example.com', hash: await browserOriginHash('example.com') };
    const branch = { pattern: 'branch.example.com', hash: await browserOriginHash('branch.example.com') };
    await p.setOrigins('project', [shared]);
    await p.setOrigins('workspace', [shared, branch]);
    await p.mutate('project', { op: 'approval', scope: 'project', executionHash: shared.hash, approved: true }, human);
    expect(approvedBrowserOrigins(await p.get('workspace'))).toEqual(['example.com']);
    await expect(p.mutate('workspace', { op: 'approval', scope: 'project', executionHash: branch.hash, approved: true }, human)).rejects.toThrow();
    await p.mutate('workspace', { op: 'approval', scope: 'workspace', executionHash: branch.hash, approved: true }, human);
    expect(approvedBrowserOrigins(await p.get('workspace'))).toEqual(['example.com', 'branch.example.com']);
    await p.setOrigins('future', [shared, branch]);
    expect(approvedBrowserOrigins(await p.get('future'))).toEqual(['example.com']);
    await p.setOrigins('workspace', [branch]);
    expect(approvedBrowserOrigins(await p.get('workspace'))).toEqual(['branch.example.com']);
    expect((await p.get('workspace')).approvals.some(entry => entry.executionHash === hash)).toBe(true);
    await p.setOrigins('workspace', [shared, branch]);
    expect(approvedBrowserOrigins(await p.get('workspace'))).toEqual(['example.com', 'branch.example.com']);
    await p.setOrigins('project', [shared, branch]);
    await p.mutate('project', { op: 'approval', scope: 'project', executionHash: branch.hash, approved: true }, human);
    expect(approvedBrowserOrigins(await p.get('future'))).toEqual(['example.com', 'branch.example.com']);
    await p.mutate('project', { op: 'approval', scope: 'project', executionHash: shared.hash, approved: false }, human);
    expect(approvedBrowserOrigins(await p.get('future'))).toEqual(['branch.example.com']);
  });

  it('stores a site’s level with its approval and shares a project level with every workspace', async () => {
    const p = await project();
    const bank = { pattern: 'bank.example', hash: await browserOriginHash('bank.example') };
    await p.setOrigins('project', [bank]);
    await p.setOrigins('workspace', [bank]);
    await p.mutate('project', { op: 'approval', scope: 'project', executionHash: bank.hash, approved: true, level: 'read' }, human);
    expect(approvedBrowserSites(await p.get('workspace'))).toEqual([{ pattern: 'bank.example', level: 'read' }]);
    await p.mutate('project', { op: 'approval', scope: 'project', executionHash: bank.hash, approved: true, level: 'full' }, human);
    expect(approvedBrowserSites(await p.get('workspace'))).toEqual([{ pattern: 'bank.example', level: 'full' }]);
    await p.mutate('workspace', { op: 'approval', scope: 'workspace', executionHash: bank.hash, approved: true, level: 'interact' }, human);
    expect(approvedBrowserSites(await p.get('workspace'))).toEqual([{ pattern: 'bank.example', level: 'interact' }]);
    expect(approvedBrowserSites(await p.get('project'))).toEqual([{ pattern: 'bank.example', level: 'full' }]);
  });

  it('requires new workspace approval after removing and re-adding an origin even with automatic policy', async () => {
    const p = await project();
    const wildcard = { pattern: '*', hash: await browserOriginHash('*') };
    const independent = { pattern: 'independent.example.com', hash: await browserOriginHash('independent.example.com') };
    for (const name of ['workspace', 'other']) {
      await p.setOrigins(name, [wildcard, independent]);
      for (const origin of [wildcard, independent]) await p.mutate(name, { op: 'approval', scope: 'workspace', executionHash: origin.hash, approved: true }, human);
    }
    await p.mutate('workspace', { op: 'approval', scope: 'workspace', executionHash: hash, approved: true }, human);
    await p.mutate('workspace', { op: 'policy', automatic: true }, human);
    const scriptApprovals = (await p.get('workspace')).approvals.filter(entry => entry.executionHash === hash);
    await p.setOrigins('workspace', [independent]);
    await p.setOrigins('workspace', [wildcard, independent]);
    const restored = await p.get('workspace');
    expect(approvedBrowserOrigins(restored)).toEqual(['independent.example.com']);
    expect(restored.approvals.filter(entry => entry.executionHash === hash)).toEqual(scriptApprovals);
    expect(approvedBrowserOrigins(await p.get('other'))).toEqual(['*', 'independent.example.com']);
    expect(restored.policy.automatic).toBe(true);
    await p.mutate('workspace', { op: 'approval', scope: 'workspace', executionHash: wildcard.hash, approved: true }, human);
    expect(approvedBrowserOrigins(await p.get('workspace'))).toEqual(['*', 'independent.example.com']);
  });

  it('revokes removed base origin approval across existing and future branches without revoking independent grants', async () => {
    const p = await project();
    const wildcard = { pattern: '*', hash: await browserOriginHash('*') };
    const independent = { pattern: 'independent.example.com', hash: await browserOriginHash('independent.example.com') };
    for (const name of ['project', 'workspace', 'other']) await p.setOrigins(name, [wildcard, independent]);
    for (const origin of [wildcard, independent]) await p.mutate('project', { op: 'approval', scope: 'project', executionHash: origin.hash, approved: true }, human);
    await p.mutate('other', { op: 'approval', scope: 'workspace', executionHash: wildcard.hash, approved: true }, human);
    await p.mutate('workspace', { op: 'policy', automatic: true }, human);
    const scriptApprovals = (await p.get('workspace')).approvals.filter(entry => entry.executionHash === hash);
    expect(approvedBrowserOrigins(await p.get('workspace'))).toEqual(['*', 'independent.example.com']);
    await p.setOrigins('project', [independent]);
    expect(approvedBrowserOrigins(await p.get('workspace'))).toEqual(['independent.example.com']);
    expect(approvedBrowserOrigins(await p.get('other'))).toEqual(['*', 'independent.example.com']);
    await p.setOrigins('project', [wildcard, independent]);
    await p.setOrigins('future', [wildcard, independent]);
    for (const name of ['project', 'workspace', 'future']) {
      const state = await p.get(name);
      expect(approvedBrowserOrigins(state)).toEqual(['independent.example.com']);
      expect(state.approvals.filter(entry => entry.executionHash === hash)).toEqual(scriptApprovals);
    }
    await p.mutate('workspace', { op: 'value', scope: 'project', name: 'RETAINED', value: 'yes' }, human);
    expect(approvedBrowserOrigins(await p.get('future'))).toEqual(['independent.example.com']);
    expect((await p.get('future')).values.project).toEqual({ RETAINED: 'yes' });
    await p.mutate('project', { op: 'approval', scope: 'project', executionHash: wildcard.hash, approved: true }, human);
    expect(approvedBrowserOrigins(await p.get('future'))).toEqual(['*', 'independent.example.com']);
  });

  it('does not inherit browser permissions from another project', async () => {
    const first = await project();
    const second = await project();
    const origin = { pattern: 'example.com', hash: await browserOriginHash('example.com') };
    await first.setOrigins('project', [origin]);
    await first.mutate('project', { op: 'approval', scope: 'project', executionHash: origin.hash, approved: true }, human);
    await second.setOrigins('workspace', [origin]);
    expect(approvedBrowserOrigins(await second.get('workspace'))).toEqual([]);
  });

  it('accepts a retry once; a newer run cancels the running one, which records cancellation when its runner stops', async () => {
    const p = await project();
    await p.mutate('workspace', claim('operation'));
    const retry = await p.mutate('workspace', claim('operation'));
    expect(retry.claim?.status).toBe('existing');
    expect(retry.runs.filter((run) => run.id === 'operation')).toHaveLength(1);
    const contender = await p.mutate('workspace', claim('contender'), { ...machine, machineId: 'machine-b' });
    expect(contender.claim?.status).toBe('claimed');
    expect(contender.runs.find((run) => run.id === 'operation')?.status).toBe('cancelling');
    const cancelled = await p.mutate('workspace', { op: 'finish', runId: 'operation', status: 'failed', exitCode: 137, results: [], output: 'stopped', bindings: {} });
    expect(cancelled.runs.find((run) => run.id === 'operation')).toMatchObject({ status: 'cancelled', failure: { code: 'Cancelled' } });
    expect((await p.get('workspace')).runs.find((run) => run.id === 'operation')?.incidents[0]?.failure?.code).toBe('Cancelled');
  });

  it('resolves a wait for a run when it ends', async () => {
    const p = await project();
    const { stub, identity } = await p.space('workspace');
    await p.mutate('workspace', claim('waited'));
    await runInDurableObject(stub, async instance => {
      const ended = instance.lifecycleRunEnded(identity, 'waited');
      await instance.mutateLifecycleState(identity, { op: 'finish', runId: 'waited', status: 'succeeded', exitCode: 0, results: [], output: 'done', bindings: {} }, machine);
      expect(await ended).toMatchObject({ id: 'waited', status: 'succeeded' });
    });
  });

  it('retains paged redacted logs and partial bindings, and carries permission failures explicitly', async () => {
    const p = await project();
    const { stub, identity } = await p.space('workspace');
    await p.mutate('workspace', claim('partial'));
    const output = `token=do-not-store\n${'line\n'.repeat(20_000)}complete\n`;
    await p.mutate('workspace', { op: 'append', runId: 'partial', output, bindings: { resource: 'allocated-before-crash' } });
    let offset: number | null = 0;
    let full = '';
    let cursor = 0;
    do {
      const page = await stub.getLifecycleRunLog(identity, 'partial', offset);
      full += page.output;
      offset = page.nextOffset;
      cursor = page.cursor;
    } while (offset !== null);
    expect(full).toBe(output.replace('do-not-store', '[REDACTED]'));
    await p.mutate('workspace', { op: 'append', runId: 'partial', output: 'later output\n' });
    const resumed = await stub.getLifecycleRunLog(identity, 'partial', cursor);
    expect(resumed.output).toBe('later output\n');
    expect((await stub.getLifecycleRunLog(identity, 'partial', resumed.cursor)).output).toBe('');
    const recovered = await p.mutate('workspace', { op: 'interrupt', runId: 'partial', reason: 'Cancelled while its machine was offline' }, human);
    expect(recovered.bindings).toEqual({ resource: 'allocated-before-crash' });
    expect(recovered.runs[0]?.status).toBe('interrupted');
    // A late report from the run's machine does not reopen the ended run.
    expect((await p.mutate('workspace', { op: 'finish', runId: 'partial', status: 'succeeded', exitCode: 0, results: [], output: '', bindings: {} })).runs[0]?.status).toBe('interrupted');
  });

  it('moves a workspace environment held by the project into the workspace object once', async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const workspaceId = `${projectId}-legacy`;
    const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
    await authority.bootstrap({ id: projectId, name: 'Project', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
    await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'legacy', branch: 'legacy', phase: null, sourceKind: 'branch', sourceRef: 'legacy', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    const run = { id: 'old-run', projectId, spaceId: workspaceId, phase: 'checks', status: 'succeeded', profile: 'base', machineId: 'machine-a', generation: null, interactive: false, executionHashes: [], terminalName: null, results: [], output: 'old output', exitCode: 0, startedAt: '2026-10-01T00:00:00.000Z', finishedAt: '2026-10-01T00:00:01.000Z', deadlineAt: '2026-10-01T00:30:00.000Z', cancelRequestedAt: null, failure: null, incidents: [] };
    await runInDurableObject(authority, (_instance, context) => {
      context.storage.sql.exec(`
        CREATE TABLE environment_state(space_id TEXT PRIMARY KEY,data TEXT NOT NULL);
        CREATE TABLE lifecycle_runs(id TEXT PRIMARY KEY,space_id TEXT NOT NULL,scope TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE lifecycle_logs(run_id TEXT NOT NULL,offset INTEGER NOT NULL,output TEXT NOT NULL,PRIMARY KEY(run_id,offset));
      `);
      const state = { revision: 7, projectId, spaceId: workspaceId, bundleJson: null, selectedProfile: 'base', values: { global: {}, project: {}, workspace: { REGION: 'eu' } }, approvals: [], policy: { automatic: true }, bindings: { db: 'kept' }, provisioned: null, destroyedAt: null, runs: [], claim: null, executions: [], browserOrigins: [], browserOriginsAvailable: true };
      context.storage.sql.exec('INSERT INTO environment_state(space_id,data) VALUES(?,?)', workspaceId, JSON.stringify(state));
      context.storage.sql.exec('INSERT INTO lifecycle_runs(id,space_id,scope,data) VALUES(?,?,?,?)', run.id, workspaceId, '["checks"]', JSON.stringify(run));
      for (let offset = 0; offset < 70; offset += 1) context.storage.sql.exec('INSERT INTO lifecycle_logs(run_id,offset,output) VALUES(?,?,?)', run.id, offset, `line ${offset}\n`);
    });
    const space = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`);
    const identity = { projectId, workspaceId };
    const moved = await space.getLifecycleState(identity);
    expect(moved).toMatchObject({ revision: 7, values: { workspace: { REGION: 'eu' } }, bindings: { db: 'kept' }, policy: { automatic: true }, runs: [{ id: 'old-run', output: 'old output' }] });
    let log = '';
    for (let offset: number | null = 0; offset !== null;) {
      const page = await space.getLifecycleRunLog(identity, 'old-run', offset);
      log += page.output;
      offset = page.nextOffset;
    }
    expect(log).toBe(Array.from({ length: 70 }, (_, offset) => `line ${offset}\n`).join(''));
    // The project no longer holds the rows, and its emptied tables are gone.
    await runInDurableObject(authority, (_instance, context) => {
      expect(context.storage.sql.exec("SELECT name FROM sqlite_master WHERE name IN ('environment_state','lifecycle_runs','lifecycle_logs')").toArray()).toEqual([]);
    });
    expect((await space.getLifecycleState(identity)).runs).toHaveLength(1);
  });
});
