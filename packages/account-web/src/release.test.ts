import type { DeploymentStatusView } from '@gitspace/protocol';
import { describe, expect, it } from 'vitest';
import { deploymentStatusFixture } from './App.js';
import { converging, machineConvergence, machineRollup, ompRollup } from './release.js';

function splitReleaseStatus(): DeploymentStatusView {
  const record = deploymentStatusFixture.releases[0]!;
  return {
    ...deploymentStatusFixture,
    desired: { worker: null, frontend: null, machine: 'machine-release', updatedAt: record.createdAt },
    current: { worker: { sha: null, version: 'channel' }, machines: { home: { sha: 'machine-release', generation: 'generation-a' } } },
    releases: [
      { ...record, sha: 'machine-release', status: { ...record.status, machines: { home: 'applied' }, omps: {} } },
      { ...record, sha: 'omp-release', status: { ...record.status, machines: {}, omps: { home: 'failed' } } },
    ],
    launch: null,
  };
}

describe('independent target convergence', () => {
  it('requires the selected complete machine generation and ignores historical OMP outcomes', () => {
    let status = splitReleaseStatus();
    expect(converging(status)).toBe(false);
    expect(machineConvergence(status)).toEqual({ applied: 1, total: 1 });
    status = { ...status, current: { ...status.current, machines: { home: { sha: 'previous-machine', generation: 'generation-a' } } } };
    expect(converging(status)).toBe(true);
    expect(machineConvergence(status)).toEqual({ applied: 0, total: 1 });
  });

  it('has converged with no machines in the fleet', () => {
    const status = { ...splitReleaseStatus(), current: { worker: { sha: null, version: 'channel' }, machines: {} } };
    expect(converging(status)).toBe(false);
    expect(machineConvergence(status)).toEqual({ applied: 0, total: 0 });
  });

  it('continues polling a channel reset until the machine has reverted', () => {
    let status = splitReleaseStatus();
    status = { ...status, desired: { ...status.desired, machine: null } };
    expect(converging(status)).toBe(true);
    status = { ...status, current: { ...status.current, machines: { home: { sha: null, generation: 'generation-a' } } } };
    expect(converging(status)).toBe(false);
  });

  it('does not poll forever after a machine activation failure', () => {
    let status = splitReleaseStatus();
    status = {
      ...status,
      current: { ...status.current, machines: { home: { sha: 'previous-machine', generation: 'generation-a' } } },
      releases: status.releases.map((record) => record.sha === status.desired.machine
        ? { ...record, status: { ...record.status, machines: { home: 'failed' } } }
        : record),
    };
    expect(converging(status)).toBe(false);
    expect(machineConvergence(status)).toEqual({ applied: 0, total: 1 });
  });

  it('converges after a pending machine leaves the current fleet while preserving its historical release results', () => {
    let status = splitReleaseStatus();
    status = {
      ...status,
      current: { ...status.current, machines: { ...status.current.machines, pending: { sha: 'previous-machine', generation: 'previous' } } },
      releases: status.releases.map((record) => ({
        ...record,
        status: {
          ...record.status,
          machines: record.sha === status.desired.machine ? { ...record.status.machines, pending: 'pending' } : record.status.machines,
        },
      })),
    };
    expect(converging(status)).toBe(true);
    expect(machineConvergence(status)).toEqual({ applied: 1, total: 2 });

    status = { ...status, current: { ...status.current, machines: { home: { sha: 'machine-release', generation: 'generation-a' } } } };
    expect(converging(status)).toBe(false);
    expect(machineConvergence(status)).toEqual({ applied: 1, total: 1 });
    expect(machineRollup(status.releases[0]!).status).toBe('pending');
    expect(ompRollup(status.releases[1]!).status).toBe('failed');
  });
});
