import type { DeploymentStatusView } from '@gitspace/protocol';
import { describe, expect, it } from 'vitest';
import { deploymentStatusFixture } from './App.js';
import { converging, machineConvergence } from './release.js';

function splitReleaseStatus(): DeploymentStatusView {
  const record = deploymentStatusFixture.releases[0]!;
  return {
    ...deploymentStatusFixture,
    desired: { worker: null, frontend: null, machine: 'machine-release', omp: 'omp-release', updatedAt: record.createdAt },
    current: { worker: { sha: null, version: 'channel' }, machines: {} },
    thisMachine: { machineId: 'home', sha: 'machine-release', ompSha: 'omp-release', ompDraining: 0, generation: 'generation-a' },
    releases: [
      { ...record, sha: 'machine-release', status: { ...record.status, machines: { home: 'applied' }, omps: {} } },
      { ...record, sha: 'omp-release', status: { ...record.status, machines: {}, omps: { home: 'applied' } } },
    ],
    launch: null,
  };
}

describe('independent target convergence', () => {
  it('requires both selected generations and waits for old OMP sessions to drain', () => {
    let status = splitReleaseStatus();
    expect(converging(status)).toBe(false);
    expect(machineConvergence(status)).toEqual({ applied: 1, total: 1 });
    status = { ...status, thisMachine: { ...status.thisMachine, ompSha: 'previous-omp' } };
    expect(converging(status)).toBe(true);
    expect(machineConvergence(status)).toEqual({ applied: 0, total: 1 });
    status = { ...status, thisMachine: { ...status.thisMachine, ompSha: status.desired.omp, ompDraining: 1 } };
    expect(converging(status)).toBe(true);
    expect(machineConvergence(status)).toEqual({ applied: 0, total: 1 });
  });

  it('continues polling a channel reset until machine and OMP have both reverted', () => {
    let status = splitReleaseStatus();
    status = { ...status, desired: { ...status.desired, machine: null, omp: null } };
    expect(converging(status)).toBe(true);
    status = { ...status, thisMachine: { ...status.thisMachine, sha: null } };
    expect(converging(status)).toBe(true);
    status = { ...status, thisMachine: { ...status.thisMachine, ompSha: null } };
    expect(converging(status)).toBe(false);
  });

  it('does not poll forever after an OMP activation failure', () => {
    let status = splitReleaseStatus();
    status = {
      ...status,
      thisMachine: { ...status.thisMachine, ompSha: 'previous-omp' },
      releases: status.releases.map((record) => record.sha === status.desired.omp
        ? { ...record, status: { ...record.status, omps: { home: 'failed' } } }
        : record),
    };
    expect(converging(status)).toBe(false);
    expect(machineConvergence(status)).toEqual({ applied: 0, total: 1 });
  });
});
