import { describe, expect, it } from 'bun:test';
import {
  emptyLifecycleState, transitionLifecycle, environmentFailure, loadEnvironmentBundle,
  isLifecycleRunActive, lifecycleRunOutcome, lifecycleExecutionOutcome, LifecycleLogReader, type LifecycleActor, type LifecycleMutation,
  type LifecycleRunRecord, type LifecycleState,
  isInteractiveLifecycleScript, assertLifecycleRequestIdentity, parseLifecycleRunRequest,
} from '../src/index.js';

const machine: LifecycleActor = { actorId: 'machine-a', machineId: 'machine-a', kind: 'machine', lifecycleControl: false };
const hash = `sha256:${'a'.repeat(64)}`;
function scenario() {
  let state = emptyLifecycleState('project', 'workspace');
  const records = new Map<string, LifecycleRunRecord>();
  let time = '2026-09-01T00:00:00.000Z';
  const apply = (input: LifecycleMutation, actor = machine): LifecycleState => {
    const transition = transitionLifecycle({ state, runs: [...records.values()], actor, now: time, token: 'ownership' }, input);
    state = transition.state;
    if (transition.record) records.set(transition.record.run.id, transition.record);
    return state;
  };
  apply({ op: 'configure', bundleJson: JSON.stringify({ version: 1, profiles: { base: {} } }), executions: [{ id: 'prepare', kind: 'script', label: 'Prepare', command: '01-prepare.sh', content: 'echo ready', fileName: '01-prepare.sh', phase: 'machine/prepare', hash }] });
  apply({ op: 'approval', scope: 'project', executionHash: hash, approved: true }, { actorId: 'browser', machineId: 'browser', kind: 'browser', lifecycleControl: true });
  return { apply, advance: (now: string) => { time = now; } };
}
const claim = (runId: string, overrides: Partial<Extract<LifecycleMutation, { op: 'claim' }>> = {}): LifecycleMutation => ({ op: 'claim', runId, phase: 'machine/prepare', profile: 'base', executionHashes: [hash], generation: 1, rerun: false, ...overrides });
const finish = (runId: string, overrides: Partial<Extract<LifecycleMutation, { op: 'finish' }>> = {}): LifecycleMutation => ({ op: 'finish', runId, token: 'ownership', status: 'succeeded', exitCode: 0, results: [], output: '', bindings: {}, ...overrides });

describe('isomorphic environment decisions', () => {
  it('recognizes only an exact interactive directive in the leading shell header', () => {
    expect(isInteractiveLifecycleScript('#!/bin/bash\r\n# rationale\r\n\r\n# gitspace: interactive\r\nread value')).toBe(true);
    expect(isInteractiveLifecycleScript('echo running\n# gitspace: interactive')).toBe(false);
    expect(isInteractiveLifecycleScript('# gitspace: interactive extra\nread value')).toBe(false);
    expect(isInteractiveLifecycleScript(' # gitspace: interactive\nread value')).toBe(false);
  });

  it('cannot upgrade a noninteractive delivery retry into a protected run', () => {
    const context = scenario();
    const accepted = context.apply(claim('identity')).runs[0]!;
    expect(() => assertLifecycleRequestIdentity({ runId: 'identity', phase: 'machine/prepare', interactive: true }, accepted)).toThrow();
    expect(() => context.apply(claim('identity', { interactive: true }))).toThrow();
    expect(() => parseLifecycleRunRequest({ runId: 'checks', phase: 'checks', interactive: true })).toThrow();
    expect(context.apply(claim('identity', { interactive: false })).claim?.status).toBe('existing');
  });

  it('requires explicit protected execution for approved interactive script bytes', () => {
    const context = scenario();
    context.apply({ op: 'configure', bundleJson: JSON.stringify({ version: 1, profiles: { base: {} } }), executions: [{ id: 'prepare', kind: 'script', label: 'Prepare', command: '01-prepare.sh', content: '# gitspace: interactive\nread value', fileName: '01-prepare.sh', phase: 'machine/prepare', hash }] });
    let failure: unknown;
    try { context.apply(claim('automatic')); } catch (error) { failure = error; }
    expect(environmentFailure(failure)?.code).toBe('InteractionRequired');
    expect(context.apply(claim('manual', { interactive: true })).runs[0]).toMatchObject({ status: 'accepted', interactive: true });
  });
  it('authorizes explicit client lifecycle control without impersonating a browser or bypassing recovery proof', () => {
    const context = scenario();
    const client: LifecycleActor = { actorId: 'api-client', machineId: 'api-client', kind: 'client', lifecycleControl: true };
    expect(() => context.apply({ op: 'approval', scope: 'project', executionHash: hash, approved: false }, { ...client, lifecycleControl: false })).toThrow();
    const approved = context.apply({ op: 'approval', scope: 'project', executionHash: hash, approved: true }, client);
    expect(approved.approvals[0]?.approvedBy).toBe('api-client');
    context.apply(claim('recover'));
    expect(() => context.apply({ op: 'cancel', runId: 'recover' }, { ...client, machineId: machine.machineId, lifecycleControl: false })).toThrow();
    expect(context.apply({ op: 'cancel', runId: 'recover' }, client).runs[0]?.status).toBe('cancelling');
    expect(() => context.apply({ op: 'abandon', runId: 'recover' }, client)).toThrow();
    expect(context.apply({ op: 'abandon', runId: 'recover' }, { ...client, destroyedMachineId: machine.machineId }).runs[0]?.status).toBe('interrupted');
  });
  it('rejects unsupported formats with typed identity instead of converting or silently emptying them', () => {
    let failure: unknown;
    try { loadEnvironmentBundle({ version: '1.0', name: 'Old bundle', onboarding: [] }); } catch (error) { failure = error; }
    expect(environmentFailure(failure)?.code).toBe('InvalidBundle');
  });

  it('separates delivery retries from new operation identities and fences ownership', () => {
    const context = scenario();
    const accepted = context.apply(claim('first'));
    expect(accepted.runs[0]?.status).toBe('accepted');
    const retried = context.apply(claim('first'));
    expect(retried.claim).toMatchObject({ status: 'existing', token: null });
    expect(retried.runs).toHaveLength(1);
    expect(() => context.apply(claim('first', { phase: 'checks' }))).toThrow();
    expect(() => context.apply(finish('first'), { ...machine, machineId: 'machine-b' })).toThrow();
    context.apply(finish('first'));
    expect(context.apply(claim('same-scope')).claim?.status).toBe('skipped');
    expect(context.apply(claim('new-machine'), { ...machine, machineId: 'machine-b' }).claim?.status).toBe('claimed');
  });

  it('keeps a cancelled operation fenced until effects stop and retains its incident after a successful retry', () => {
    const context = scenario();
    context.apply(claim('cancelled'));
    const cancelling = context.apply({ op: 'cancel', runId: 'cancelled' });
    expect(isLifecycleRunActive(cancelling.runs[0]!)).toBe(true);
    expect(() => context.apply(claim('too-early'))).toThrow();
    const stopped = context.apply(finish('cancelled', { status: 'failed', exitCode: 137 }));
    expect(stopped.runs[0]).toMatchObject({ status: 'cancelled', failure: { code: 'Cancelled' } });
    context.advance('2026-09-01T00:00:01.000Z');
    context.apply(claim('retry', { rerun: true }));
    const recovered = context.apply(finish('retry'));
    expect(lifecycleRunOutcome(recovered.runs[0]!)).toBe('succeeded');
    expect(recovered.runs.find((run) => run.id === 'cancelled')?.incidents[0]?.failure?.code).toBe('Cancelled');
  });

  it('never records late completion as success after the accepted deadline', () => {
    const context = scenario();
    context.apply(claim('deadline', { deadlineAt: '2026-09-01T00:00:01.000Z' }));
    context.advance('2026-09-01T00:00:01.000Z');
    const expired = context.apply(finish('deadline', { bindings: { partial: 'resource-before-timeout' } }));
    expect(expired.runs[0]).toMatchObject({ status: 'timed-out', exitCode: 1, failure: { code: 'DeadlineExceeded' } });
    expect(expired.bindings).toEqual({ partial: 'resource-before-timeout' });
  });
  it('keeps independent script exits across split frames, unstarted scripts, and an interrupted successor', () => {
    const first = 'workspace/materialize:10-dependencies.sh';
    const second = 'workspace/materialize:20-environment.sh';
    const third = 'workspace/materialize:30-unstarted.sh';
    const marker = (kind: 'START' | 'END', id: string, exit?: number) => `__GITSPACE_${kind}__${Buffer.from(id).toString('base64url')}${exit === undefined ? '' : `:${exit}`}\n`;
    const prefix = `${marker('START', first)}installed\n${marker('END', first, 0)}${marker('START', second)}ownership rejected\n`;
    const log = prefix + marker('END', second, 1);
    for (let split = 0; split <= log.length; split++) {
      const reader = new LifecycleLogReader();
      reader.push(log.slice(0, split));
      reader.push(log.slice(split), { final: true });
      expect(reader.results).toEqual([{ id: first, exitCode: 0, output: 'installed\n' }, { id: second, exitCode: 1, output: 'ownership rejected\n' }]);
    }
    const context = scenario();
    context.apply(claim('steps'));
    const reader = new LifecycleLogReader();
    reader.push(prefix, { at: '2026-09-01T00:00:01.000Z' });
    const active = context.apply({ op: 'append', runId: 'steps', token: 'ownership', output: prefix, results: reader.results }).runs[0]!;
    expect(lifecycleExecutionOutcome(active, first)).toBe('succeeded');
    expect(lifecycleExecutionOutcome(active, second)).toBe('running');
    expect(lifecycleExecutionOutcome(active, third)).toBe('not-started');
    const interrupted = context.apply(finish('steps', { status: 'interrupted', exitCode: 137 })).runs[0]!;
    expect(lifecycleExecutionOutcome(interrupted, first)).toBe('succeeded');
    expect(lifecycleExecutionOutcome(interrupted, second)).toBe('interrupted');
    expect(lifecycleExecutionOutcome(interrupted, third)).toBe('not-started');
    expect(interrupted.results[1]?.exitCode).toBeNull();
    reader.push(marker('END', second, 1), { at: '2026-09-01T00:00:02.000Z', final: true });
    const failed = { ...interrupted, results: reader.results };
    expect(lifecycleExecutionOutcome(failed, first)).toBe('succeeded');
    expect(lifecycleExecutionOutcome(failed, second)).toBe('failed');
    expect(failed.results[1]).toMatchObject({ startedAt: '2026-09-01T00:00:01.000Z', finishedAt: '2026-09-01T00:00:02.000Z' });
  });

  it('isolates a selected script across pages and withholds an unfinished control marker', () => {
    const reader = new LifecycleLogReader({ selectedId: 'second' });
    reader.push('__GITSPACE_START__Zmlyc3Q\nother output\n__GITSPACE_END__Zmlyc3Q:0\n__GIT');
    reader.push('SPACE_START__c2Vjb25k\nselected output');
    expect(reader.results.find((result) => result.id === 'second')).toEqual({ id: 'second', exitCode: null, output: 'selected output' });
    reader.push('__GITSPACE_END__c2Vjb25k:');
    expect(reader.results[1]?.output).toBe('selected output');
    reader.push('1\n__GITSPACE_START__dGhpcmQ\nnot selected\n', { final: true });
    expect(reader.results.find((result) => result.id === 'second')).toEqual({ id: 'second', exitCode: 1, output: 'selected output' });
    expect(reader.results.filter((result) => result.id !== 'second').every((result) => result.output === '')).toBe(true);
  });
});
