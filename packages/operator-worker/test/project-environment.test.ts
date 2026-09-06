import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { LifecycleMutation } from '@gitspace/protocol';
import type { ProjectAuthorityDO } from '../src/project-authority.js';

const hashA = `sha256:${'a'.repeat(64)}`;
const hashB = `sha256:${'b'.repeat(64)}`;
const machineA = { actorId: 'machine-a', machineId: 'machine-a', human: false };
const machineB = { actorId: 'machine-b', machineId: 'machine-b', human: false };
const browser = { actorId: 'browser', machineId: 'browser', human: true };
async function ledger() {
  const authority = (env.PROJECT_AUTHORITY as DurableObjectNamespace<ProjectAuthorityDO>).getByName(`environment-${crypto.randomUUID()}`);
  await authority.bootstrap({ id: 'project', name: 'Project', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
  for (const id of ['workspace-a', 'workspace-b']) {
    await authority.putWorkspace({ id, projectId: 'project', kind: 'worktree', name: id, branch: id, phase: null, sourceKind: 'branch', sourceRef: id, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await authority.mutateLifecycleState(id, { op: 'configure', bundleJson: JSON.stringify({ version: 1, profiles: { base: {}, dev: {} } }) }, machineA);
    await authority.mutateLifecycleState(id, { op: 'policy', automatic: true }, machineA);
  }
  for (const executionHash of [hashA, hashB]) await authority.mutateLifecycleState('workspace-a', { op: 'approval', scope: 'project', executionHash, approved: true }, browser);
  return authority;
}
const claim = (runId: string, phase: Extract<LifecycleMutation, { op: 'claim' }>['phase'] = 'cloud/provision', overrides: Partial<Extract<LifecycleMutation, { op: 'claim' }>> = {}): Extract<LifecycleMutation, { op: 'claim' }> => ({
  op: 'claim', runId, phase, profile: 'base', executionHashes: [hashA], generation: 1, rerun: false, ...overrides,
});
const finish = (runId: string, token: string, overrides: Partial<Extract<LifecycleMutation, { op: 'finish' }>> = {}): Extract<LifecycleMutation, { op: 'finish' }> => ({
  op: 'finish', runId, token, status: 'succeeded', exitCode: 0, results: [], output: '', bindings: {}, ...overrides,
});

describe('durable repository lifecycle authority', () => {
  it('claims once across machines and preserves successful provisioning through changed scripts and a failed rerun', async () => {
    const authority = await ledger();
    const contenders = await Promise.all([
      authority.mutateLifecycleState('workspace-a', claim('first-a'), machineA),
      authority.mutateLifecycleState('workspace-a', claim('first-b'), machineB),
    ]);
    expect(contenders.map((state) => state.claim!.status).sort()).toEqual(['blocked', 'claimed']);
    const index = contenders.findIndex((state) => state.claim!.status === 'claimed');
    const winner = contenders[index]!.claim!;
    const owner = index === 0 ? machineA : machineB;
    const other = index === 0 ? machineB : machineA;
    await runInDurableObject(authority, (instance) => {
      expect(() => instance.mutateLifecycleState('workspace-a', finish(winner.runId, winner.token!), other)).toThrow('another machine');
    });
    await authority.mutateLifecycleState('workspace-a', finish(winner.runId, winner.token!, { bindings: { database: 'db-original' } }), owner);
    await authority.mutateLifecycleState('workspace-a', { op: 'profile', profile: 'dev' }, other);
    await authority.mutateLifecycleState('workspace-a', { op: 'value', scope: 'project', name: 'REGION', value: 'west' }, other);
    const moved = await authority.mutateLifecycleState('workspace-a', claim('moved', 'cloud/provision', { executionHashes: [hashB], profile: 'dev', generation: 2 }), other);
    expect(moved.claim?.status).toBe('skipped');
    expect(moved.provisioned?.runId).toBe(winner.runId);
    const rerun = await authority.mutateLifecycleState('workspace-a', claim('rerun', 'cloud/provision', { rerun: true, executionHashes: [hashB] }), other);
    const failed = await authority.mutateLifecycleState('workspace-a', finish('rerun', rerun.claim!.token!, { status: 'failed', exitCode: 1, bindings: { bucket: 'partially-created' } }), other);
    expect(failed.bindings).toEqual({ database: 'db-original', bucket: 'partially-created' });
    expect(failed.provisioned?.runId).toBe(winner.runId);
    expect(failed.values.project).toEqual({ REGION: 'west' });
    expect(failed.runs.find((run) => run.id === 'rerun')?.status).toBe('failed');
    expect((await authority.mutateLifecycleState('workspace-a', claim('again'), owner)).claim?.status).toBe('skipped');
    await runInDurableObject(authority, (instance) => {
      expect(() => instance.removeWorkspace('workspace-a', 1)).toThrow('cloud/destroy');
      expect(() => instance.deleteProject(1)).toThrow('cloud/destroy');
    });
    expect((await authority.getLifecycleState('workspace-a')).bindings).toEqual(failed.bindings);
    const destroy = await authority.mutateLifecycleState('workspace-a', claim('destroy', 'cloud/destroy'), other);
    await authority.mutateLifecycleState('workspace-a', finish('destroy', destroy.claim!.token!), other);
    expect(await authority.removeWorkspace('workspace-a', 1)).toBe(true);
  });

  it('separates exclusive execution locks from preparation and checkout-generation success scopes', async () => {
    const authority = await ledger();
    const first = await authority.mutateLifecycleState('workspace-a', claim('prepare-a', 'machine/prepare'), machineA);
    expect((await authority.mutateLifecycleState('workspace-b', claim('prepare-overlap', 'machine/prepare', { executionHashes: [hashB] }), machineA)).claim?.status).toBe('blocked');
    expect((await authority.mutateLifecycleState('workspace-a', claim('materialize-overlap', 'workspace/materialize', { executionHashes: [hashB] }), machineA)).claim?.status).toBe('blocked');
    await authority.mutateLifecycleState('workspace-a', finish('prepare-a', first.claim!.token!), machineA);
    expect((await authority.mutateLifecycleState('workspace-b', claim('prepare-reuse', 'machine/prepare'), machineA)).claim?.status).toBe('skipped');
    const freshMachine = await authority.mutateLifecycleState('workspace-b', claim('prepare-b', 'machine/prepare'), machineB);
    expect(freshMachine.claim?.status).toBe('claimed');
    await authority.mutateLifecycleState('workspace-b', finish('prepare-b', freshMachine.claim!.token!), machineB);
    const materialized = await authority.mutateLifecycleState('workspace-a', claim('materialize-1', 'workspace/materialize'), machineA);
    await authority.mutateLifecycleState('workspace-a', finish('materialize-1', materialized.claim!.token!), machineA);
    expect((await authority.mutateLifecycleState('workspace-a', claim('edited', 'workspace/materialize', { executionHashes: [hashB] }), machineA)).claim?.status).toBe('skipped');
    expect((await authority.mutateLifecycleState('workspace-a', claim('materialize-2', 'workspace/materialize', { generation: 2 }), machineB)).claim?.status).toBe('claimed');
  });

  it('retains paged redacted logs and incremental bindings while fencing unsafe recovery and stale completion', async () => {
    const authority = await ledger();
    await runInDurableObject(authority, (instance) => {
      expect(() => instance.mutateLifecycleState('workspace-a', { op: 'approval', scope: 'workspace', executionHash: hashA, approved: true }, machineA)).toThrow('human browser');
      expect(() => instance.getLifecycleState('unknown-space')).toThrow('does not belong');
    });
    const running = await authority.mutateLifecycleState('workspace-a', claim('uncertain'), machineA);
    const output = `token=do-not-store\n${'line\n'.repeat(20_000)}complete\n`;
    await authority.mutateLifecycleState('workspace-a', { op: 'append', runId: 'uncertain', token: running.claim!.token!, output, bindings: { resource: 'allocated-before-crash' } }, machineA);
    const saved = await authority.getLifecycleState('workspace-a');
    expect(saved.bindings).toEqual({ resource: 'allocated-before-crash' });
    expect(saved.runs[0]!.output).not.toContain('do-not-store');
    let offset: number | null = 0;
    let full = '';
    do {
      const page = await authority.getLifecycleRunLog('workspace-a', 'uncertain', offset);
      full += page.output; offset = page.nextOffset;
    } while (offset !== null);
    expect(full).toBe(output.replace('do-not-store', '[REDACTED]'));
    await runInDurableObject(authority, (instance) => {
      expect(() => instance.mutateLifecycleState('workspace-a', { op: 'abandon', runId: 'uncertain' }, browser)).toThrow('confirmed destruction');
    });
    await authority.mutateLifecycleState('workspace-a', { op: 'abandon', runId: 'uncertain' }, { ...browser, destroyedMachineId: machineA.machineId });
    await runInDurableObject(authority, (instance) => {
      expect(() => instance.mutateLifecycleState('workspace-a', finish('uncertain', running.claim!.token!), machineA)).toThrow('fenced');
    });
    expect((await authority.mutateLifecycleState('workspace-a', claim('unsafe-auto'), machineB)).claim?.status).toBe('blocked');
    expect((await authority.mutateLifecycleState('workspace-a', claim('explicit-recovery', 'cloud/provision', { rerun: true }), machineB)).claim?.status).toBe('claimed');
  });
});
