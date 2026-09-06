import { describe, expect, it } from 'vitest';
import type { LifecycleRun, LifecycleState } from '@gitspace/protocol';
import { latestLifecycleRun, lifecycleSummary } from './lifecycle.js';

const completed: LifecycleRun = {
  id: 'run-a', projectId: 'project-a', spaceId: 'workspace-a', phase: 'machine/prepare', status: 'succeeded',
  profile: 'base', machineId: 'machine-a', generation: 1, executionHashes: [], terminalName: null,
  results: [], output: 'Dependencies installed', exitCode: 0, startedAt: '2026-09-01T00:00:00.000Z', finishedAt: '2026-09-01T00:00:01.000Z',
};
const state: LifecycleState = {
  revision: 1, projectId: 'project-a', spaceId: 'workspace-a', bundleJson: null, selectedProfile: 'base',
  values: { global: {}, project: {}, workspace: {} }, approvals: [], policy: { automatic: true }, bindings: {},
  provisioned: null, destroyedAt: null, runs: [], claim: null, executions: [],
};

describe('environment readiness scopes', () => {
  it('does not report another machine or profile preparation as current readiness', () => {
    const ledger = { ...state, runs: [completed] };
    expect(latestLifecycleRun(ledger, 'machine/prepare', { machineId: 'machine-b', profile: 'base' })).toBeUndefined();
    expect(latestLifecycleRun(ledger, 'machine/prepare', { machineId: 'machine-a', profile: 'ios' })).toBeUndefined();
    expect(latestLifecycleRun(ledger, 'machine/prepare', { machineId: 'machine-a', profile: 'base', generation: 2 })?.status).toBe('succeeded');
  });

  it('requires fresh materialization for a new checkout while retaining durable provisioning', () => {
    const ledger: LifecycleState = { ...state, runs: [{ ...completed, phase: 'workspace/materialize' }, { ...completed, id: 'provision', phase: 'cloud/provision' }] };
    const moved = { machineId: 'machine-b', profile: 'base', generation: 2 };
    expect(latestLifecycleRun(ledger, 'workspace/materialize', { ...moved, machineId: 'machine-a' })).toBeUndefined();
    expect(latestLifecycleRun(ledger, 'cloud/provision', moved)?.status).toBe('succeeded');
  });

  it('keeps a materialized checkout complete after profile changes until an explicit rerun', () => {
    const ledger: LifecycleState = { ...state, runs: [{ ...completed, phase: 'workspace/materialize' }] };
    expect(latestLifecycleRun(ledger, 'workspace/materialize', { machineId: 'machine-a', profile: 'ios', generation: 1 })?.status).toBe('succeeded');
  });
  it('keeps failed reruns actionable without treating an earlier success as the latest attempt', () => {
    const failed: LifecycleRun = { ...completed, id: 'rerun', status: 'failed', exitCode: 1, startedAt: '2026-09-02T00:00:00.000Z' };

    const ledger = { ...state, runs: [completed, failed] };
    expect(latestLifecycleRun(ledger, 'machine/prepare')?.status).toBe('failed');
    expect(lifecycleSummary(ledger).attention).toBe(true);
  });
});
