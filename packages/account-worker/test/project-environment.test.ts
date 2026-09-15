import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { EnvironmentError, type LifecycleActor, type LifecycleMutation } from '@gitspace/protocol-environment';
import type { ProjectAuthorityDO } from '../src/project-authority.js';

const hash = `sha256:${'a'.repeat(64)}`;
const machine = { actorId: 'machine-a', machineId: 'machine-a', human: false };
const human = { actorId: 'browser', machineId: 'browser', human: true };
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
