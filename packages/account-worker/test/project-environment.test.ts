import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { EnvironmentError, approvedBrowserOrigins, browserOriginHash, type LifecycleActor, type LifecycleMutation } from '@gitspace/protocol-environment';
import type { ProjectAuthorityDO } from '../src/project-authority.js';
import { ProjectEnvironmentStore } from '../src/project-environment.js';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import * as committedOrigins from '../src/committed-browser-origins.js';

const hash = `sha256:${'a'.repeat(64)}`;
const machine = { actorId: 'machine-a', machineId: 'machine-a', kind: 'machine' as const, lifecycleControl: false };
const human = { actorId: 'browser', machineId: 'browser', kind: 'browser' as const, lifecycleControl: true };
async function ledger() {
  const authority = (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`environment-${crypto.randomUUID()}`);
  await authority.bootstrap({ id: 'project', name: 'Project', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
  await authority.putWorkspace({ id: 'workspace', projectId: 'project', kind: 'worktree', name: 'Workspace', branch: 'feature', phase: null, sourceKind: 'branch', sourceRef: 'feature', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  await authority.mutateLifecycleState('workspace', { op: 'configure', bundleJson: JSON.stringify({ version: 1, profiles: { base: {} } }), executions: [{ id: 'prepare', kind: 'script', phase: 'machine/prepare', label: 'Prepare', command: '01-prepare.sh', fileName: '01-prepare.sh', content: 'echo prepare', hash }] }, machine);
  await authority.mutateLifecycleState('workspace', { op: 'approval', scope: 'project', executionHash: hash, approved: true }, human);
  return authority;
}
async function mutate(authority: DurableObjectStub<ProjectAuthorityDO>, input: LifecycleMutation, actor: LifecycleActor = machine) {
  const result = await authority.mutateLifecycleState('workspace', input, actor);
  if (result.status === 'error') throw new EnvironmentError(result.failure.code, result.failure.message, result.failure.context);
  return result.state;
}
const claim = (runId: string): LifecycleMutation => ({ op: 'claim', runId, phase: 'machine/prepare', profile: 'base', executionHashes: [hash], generation: 1, rerun: false });

describe('durable environment authority', () => {
  for (const scope of ['project', 'workspace'] as const) it(`retains ${scope} browser approval across failed committed refresh without granting stale origins`, async () => {
    const authority = await ledger();
    await runInDurableObject(authority, async (instance, context) => {
      instance.ensureBaseWorkspace({ userId: env.ACCOUNT_ID, projectId: 'project' });
      const store = new ProjectEnvironmentStore(context.storage);
      const spaceId = scope === 'project' ? 'project' : 'workspace';
      const origin = { pattern: 'example.com', hash: await browserOriginHash('example.com') };
      const repository = { id: 'repo', name: 'repo', description: null, defaultBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastPushAt: null, source: null, readOnly: false, remote: 'https://example.com/repo.git' };
      const initialize = vi.spyOn(ArtifactsCodeStore.prototype, 'ensureEmptyProject').mockResolvedValue(repository);
      const fork = vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(repository);
      const committed = vi.spyOn(committedOrigins, 'committedBrowserOrigins').mockResolvedValue({ commit: 'a'.repeat(40), origins: [origin] });
      try {
        await instance.refreshBrowserOrigins(spaceId);
        store.mutate('project', spaceId, { op: 'approval', scope, executionHash: origin.hash, approved: true }, human);
        const approvals = store.get('project', spaceId).approvals;
        committed.mockRejectedValueOnce(new Error('Committed repository unavailable'));
        await expect(instance.refreshBrowserOrigins(spaceId)).rejects.toThrow('Committed repository unavailable');
        const unavailable = new ProjectEnvironmentStore(context.storage);
        expect(unavailable.get('project', spaceId).approvals).toEqual(approvals);
        expect(approvedBrowserOrigins(instance.getLifecycleState(spaceId))).toEqual([]);
        expect(instance.mutateLifecycleState(spaceId, { op: 'approval', scope, executionHash: origin.hash, approved: true }, human)).toMatchObject({ status: 'error', failure: { code: 'ContentChanged' } });
        // Other environment writes and shared publications cannot restore stale content.
        instance.mutateLifecycleState(spaceId, { op: 'policy', automatic: true }, human);
        instance.setEnvironmentValue('RETAINED', 'yes');
        expect(approvedBrowserOrigins(instance.getLifecycleState(spaceId))).toEqual([]);
        expect(approvedBrowserOrigins(await instance.refreshBrowserOrigins(spaceId))).toEqual(['example.com']);
        expect(store.get('project', spaceId).approvals).toEqual(approvals);
        // Only a successful committed removal prunes the retained observation.
        committed.mockRejectedValueOnce(new Error('Committed repository unavailable'));
        await expect(instance.refreshBrowserOrigins(spaceId)).rejects.toThrow('Committed repository unavailable');
        committed.mockResolvedValueOnce({ commit: 'b'.repeat(40), origins: [] });
        expect(approvedBrowserOrigins(await instance.refreshBrowserOrigins(spaceId))).toEqual([]);
        expect(approvedBrowserOrigins(await instance.refreshBrowserOrigins(spaceId))).toEqual([]);
        expect(store.get('project', spaceId).approvals.some(entry => entry.executionHash === origin.hash)).toBe(false);
      } finally {
        committed.mockRestore(); fork.mockRestore(); initialize.mockRestore();
      }
    });
  });

  it('inherits base approvals only where the committed workspace declares the origin', async () => {
    const authority = await ledger();
    await runInDurableObject(authority, async (_instance, context) => {
      const store = new ProjectEnvironmentStore(context.storage);
      const shared = { pattern: 'example.com', hash: await browserOriginHash('example.com') };
      const branch = { pattern: 'branch.example.com', hash: await browserOriginHash('branch.example.com') };
      store.setBrowserOrigins('project', 'project', [shared]);
      store.setBrowserOrigins('project', 'workspace', [shared, branch]);
      store.mutate('project', 'project', { op: 'approval', scope: 'project', executionHash: shared.hash, approved: true }, human);
      expect(approvedBrowserOrigins(store.get('project', 'workspace'))).toEqual(['example.com']);
      expect(() => store.mutate('project', 'workspace', { op: 'approval', scope: 'project', executionHash: branch.hash, approved: true }, human)).toThrow();
      store.mutate('project', 'workspace', { op: 'approval', scope: 'workspace', executionHash: branch.hash, approved: true }, human);
      expect(approvedBrowserOrigins(store.get('project', 'workspace'))).toEqual(['example.com', 'branch.example.com']);
      store.setBrowserOrigins('project', 'future', [shared, branch]);
      expect(approvedBrowserOrigins(store.get('project', 'future'))).toEqual(['example.com']);
      store.setBrowserOrigins('project', 'workspace', [branch]);
      expect(approvedBrowserOrigins(store.get('project', 'workspace'))).toEqual(['branch.example.com']);
      expect(store.get('project', 'workspace').approvals.some(entry => entry.executionHash === hash)).toBe(true);
      store.setBrowserOrigins('project', 'workspace', [shared, branch]);
      expect(approvedBrowserOrigins(store.get('project', 'workspace'))).toEqual(['example.com', 'branch.example.com']);
      store.setBrowserOrigins('project', 'project', [shared, branch]);
      store.mutate('project', 'project', { op: 'approval', scope: 'project', executionHash: branch.hash, approved: true }, human);
      expect(approvedBrowserOrigins(store.get('project', 'future'))).toEqual(['example.com', 'branch.example.com']);
      store.mutate('project', 'project', { op: 'approval', scope: 'project', executionHash: shared.hash, approved: false }, human);
      expect(approvedBrowserOrigins(store.get('project', 'future'))).toEqual(['branch.example.com']);
    });
  });
  it('requires new workspace approval after removing and re-adding an origin even with automatic policy', async () => {
    const authority = await ledger();
    await runInDurableObject(authority, async (_instance, context) => {
      const store = new ProjectEnvironmentStore(context.storage);
      const wildcard = { pattern: '*', hash: await browserOriginHash('*') };
      const independent = { pattern: 'independent.example.com', hash: await browserOriginHash('independent.example.com') };
      for (const spaceId of ['workspace', 'other']) {
        store.setBrowserOrigins('project', spaceId, [wildcard, independent]);
        for (const origin of [wildcard, independent]) store.mutate('project', spaceId, { op: 'approval', scope: 'workspace', executionHash: origin.hash, approved: true }, human);
      }
      store.mutate('project', 'workspace', { op: 'approval', scope: 'workspace', executionHash: hash, approved: true }, human);
      store.mutate('project', 'workspace', { op: 'policy', automatic: true }, human);
      const scriptApprovals = store.get('project', 'workspace').approvals.filter(entry => entry.executionHash === hash);
      store.setBrowserOrigins('project', 'workspace', [independent]);
      store.setBrowserOrigins('project', 'workspace', [wildcard, independent]);
      const restored = new ProjectEnvironmentStore(context.storage).get('project', 'workspace');
      expect(approvedBrowserOrigins(restored)).toEqual(['independent.example.com']);
      expect(restored.approvals.filter(entry => entry.executionHash === hash)).toEqual(scriptApprovals);
      expect(approvedBrowserOrigins(store.get('project', 'other'))).toEqual(['*', 'independent.example.com']);
      expect(restored.policy.automatic).toBe(true);
      store.mutate('project', 'workspace', { op: 'approval', scope: 'workspace', executionHash: wildcard.hash, approved: true }, human);
      expect(approvedBrowserOrigins(store.get('project', 'workspace'))).toEqual(['*', 'independent.example.com']);
    });
  });

  it('revokes removed base origin approval across existing and future branches without revoking independent grants', async () => {
    const authority = await ledger();
    await runInDurableObject(authority, async (_instance, context) => {
      const store = new ProjectEnvironmentStore(context.storage);
      const wildcard = { pattern: '*', hash: await browserOriginHash('*') };
      const independent = { pattern: 'independent.example.com', hash: await browserOriginHash('independent.example.com') };
      for (const spaceId of ['project', 'workspace', 'other']) store.setBrowserOrigins('project', spaceId, [wildcard, independent]);
      for (const origin of [wildcard, independent]) store.mutate('project', 'project', { op: 'approval', scope: 'project', executionHash: origin.hash, approved: true }, human);
      store.mutate('project', 'other', { op: 'approval', scope: 'workspace', executionHash: wildcard.hash, approved: true }, human);
      store.mutate('project', 'workspace', { op: 'policy', automatic: true }, human);
      const scriptApprovals = store.get('project', 'workspace').approvals.filter(entry => entry.executionHash === hash);
      expect(approvedBrowserOrigins(store.get('project', 'workspace'))).toEqual(['*', 'independent.example.com']);
      store.setBrowserOrigins('project', 'project', [independent]);
      expect(approvedBrowserOrigins(store.get('project', 'workspace'))).toEqual(['independent.example.com']);
      expect(approvedBrowserOrigins(store.get('project', 'other'))).toEqual(['*', 'independent.example.com']);
      store.setBrowserOrigins('project', 'project', [wildcard, independent]);
      store.setBrowserOrigins('project', 'future', [wildcard, independent]);
      const reopened = new ProjectEnvironmentStore(context.storage);
      for (const spaceId of ['project', 'workspace', 'future']) {
        const state = reopened.get('project', spaceId);
        expect(approvedBrowserOrigins(state)).toEqual(['independent.example.com']);
        expect(state.approvals.filter(entry => entry.executionHash === hash)).toEqual(scriptApprovals);
      }
      store.mutate('project', 'workspace', { op: 'value', scope: 'project', name: 'RETAINED', value: 'yes' }, human);
      expect(approvedBrowserOrigins(store.get('project', 'future'))).toEqual(['independent.example.com']);
      store.mutate('project', 'project', { op: 'approval', scope: 'project', executionHash: wildcard.hash, approved: true }, human);
      expect(approvedBrowserOrigins(store.get('project', 'future'))).toEqual(['*', 'independent.example.com']);
    });
  });

  it('does not inherit browser permissions from another user authority', async () => {
    const first = await ledger();
    const second = await ledger();
    const origin = { pattern: 'example.com', hash: await browserOriginHash('example.com') };
    await runInDurableObject(first, (_instance, context) => {
      const store = new ProjectEnvironmentStore(context.storage);
      store.setBrowserOrigins('project', 'project', [origin]);
      store.mutate('project', 'project', { op: 'approval', scope: 'project', executionHash: origin.hash, approved: true }, human);
    });
    await runInDurableObject(second, (_instance, context) => {
      const store = new ProjectEnvironmentStore(context.storage);
      store.setBrowserOrigins('project', 'workspace', [origin]);
      expect(approvedBrowserOrigins(store.get('project', 'workspace'))).toEqual([]);
    });
  });

  it('accepts a retry once, fences contenders, and keeps cancellation unresolved until the runner stops', async () => {
    const authority = await ledger();
    const accepted = await mutate(authority, claim('operation'));
    const token = accepted.claim!.token!;
    const retry = await mutate(authority, claim('operation'));
    expect(retry.claim?.status).toBe('existing');
    expect(retry.runs.filter((run) => run.id === 'operation')).toHaveLength(1);
    await expect(mutate(authority, claim('contender'), { ...machine, machineId: 'machine-b' })).rejects.toMatchObject({ code: 'RunConflict' });
    const cancelling = await mutate(authority, { op: 'cancel', runId: 'operation' }, human);
    expect(cancelling.runs[0]?.status).toBe('cancelling');
    await expect(mutate(authority, claim('still-fenced'))).rejects.toMatchObject({ code: 'RunConflict' });
    const cancelled = await mutate(authority, { op: 'finish', runId: 'operation', token, status: 'failed', exitCode: 137, results: [], output: 'stopped', bindings: {} });
    expect(cancelled.runs[0]).toMatchObject({ status: 'cancelled', failure: { code: 'Cancelled' } });
    expect((await authority.getLifecycleState('workspace')).runs[0]?.incidents[0]?.failure?.code).toBe('Cancelled');
  });

  it('retains paged redacted logs and partial bindings, and carries permission failures explicitly', async () => {
    const authority = await ledger();
    const accepted = await mutate(authority, claim('partial'));
    const token = accepted.claim!.token!;
    const output = `token=do-not-store\n${'line\n'.repeat(20_000)}complete\n`;
    await mutate(authority, { op: 'append', runId: 'partial', token, output, bindings: { resource: 'allocated-before-crash' } });
    let offset: number | null = 0;
    let full = '';
    let cursor = 0;
    do {
      const page = await authority.getLifecycleRunLog('workspace', 'partial', offset);
      full += page.output;
      offset = page.nextOffset;
      cursor = page.cursor;
    } while (offset !== null);
    expect(full).toBe(output.replace('do-not-store', '[REDACTED]'));
    await mutate(authority, { op: 'append', runId: 'partial', token, output: 'later output\n' });
    const resumed = await authority.getLifecycleRunLog('workspace', 'partial', cursor);
    expect(resumed.output).toBe('later output\n');
    expect((await authority.getLifecycleRunLog('workspace', 'partial', resumed.cursor)).output).toBe('');
    const denied = await authority.mutateLifecycleState('workspace', { op: 'abandon', runId: 'partial' }, human);
    expect(denied).toMatchObject({ status: 'error', failure: { code: 'PermissionDenied' } });
    const recovered = await mutate(authority, { op: 'abandon', runId: 'partial' }, { ...human, destroyedMachineId: machine.machineId });
    expect(recovered.bindings).toEqual({ resource: 'allocated-before-crash' });
    expect(recovered.runs[0]?.status).toBe('interrupted');
    await expect(mutate(authority, { op: 'finish', runId: 'partial', token, status: 'succeeded', exitCode: 0, results: [], output: '', bindings: {} })).rejects.toMatchObject({ code: 'RunFenced' });
  });
});
