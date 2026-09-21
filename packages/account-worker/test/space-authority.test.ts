import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { SpaceAuthorityDO } from '../src/space-authority.js';

const manifestHash = `sha256:${'a'.repeat(64)}`;

describe('SpaceAuthorityDO', () => {
  it('only restores the fenced same-machine restart marker and consumes it after opening', async () => {
    const stub = env.SPACE_AUTHORITY.getByName('space-restart');
    const identity = { projectId: 'project-a', spaceId: 'space-restart', machineId: 'machine-a' };
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.bootstrap(identity));
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginClose({ ...identity, expectedGeneration: 1 }));
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.commitClosed({
      ...identity, expectedGeneration: 1, revision: 1,
      manifestKey: 'projects/project-a/spaces/space-restart/checkpoints/1/manifest.enc',
      manifestHash, resumeOnMachineRestart: true,
    }));
    expect(await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.get())).toMatchObject({ state: 'closed', generation: 2, resumeMachineId: 'machine-a' });
    await expect(runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginOpen({
      ...identity, machineId: 'machine-b', expectedGeneration: 2, resumeOnMachineRestart: true,
    }))).resolves.toMatchObject({ status: 'error', failure: { code: 'WORKSPACE_POSSESSION_DENIED' } });
    await expect(runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginOpen({
      ...identity, expectedGeneration: 1, resumeOnMachineRestart: true,
    }))).resolves.toMatchObject({ status: 'error', failure: { code: 'WORKSPACE_POSSESSION_DENIED' } });
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginOpen({ ...identity, expectedGeneration: 2, resumeOnMachineRestart: true }));
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.commitOpen({ ...identity, expectedGeneration: 2, revision: 1 }));
    expect(await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.get())).toMatchObject({ state: 'open', machineId: 'machine-a', generation: 3, resumeMachineId: null });
    await expect(runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginOpen({
      ...identity, expectedGeneration: 2, resumeOnMachineRestart: true,
    }))).resolves.toMatchObject({ status: 'error', failure: { code: 'WORKSPACE_POSSESSION_DENIED' } });
  });
  it('fences generations across durable close and reopen', async () => {
    const stub = env.SPACE_AUTHORITY.getByName('space-a');
    const initial = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.bootstrap({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-a' }));
    expect(initial).toMatchObject({ status: 'ok', value: { state: 'open', machineId: 'machine-a', generation: 1, checkpointRevision: 0 } });
    const close = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginClose({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-a', expectedGeneration: 1 }));
    expect(close).toEqual({ status: 'ok', value: { revision: 1, previousRevision: null } });
    await expect(runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.commitClosed({ projectId: 'project-a', spaceId: 'space-a', machineId: 'stale-machine', expectedGeneration: 1, revision: 1, manifestKey: 'projects/project-a/spaces/space-a/checkpoints/1/manifest.enc', manifestHash }))).resolves.toMatchObject({ status: 'error', failure: { code: 'WORKSPACE_POSSESSION_DENIED' } });
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.commitClosed({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-a', expectedGeneration: 1, revision: 1, manifestKey: 'projects/project-a/spaces/space-a/checkpoints/1/manifest.enc', manifestHash }));
    const closed = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.get());
    expect(closed).toMatchObject({ state: 'closed', machineId: null, generation: 2, checkpointRevision: 1 });
    await expect(runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginOpen({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-b', expectedGeneration: 1 }))).resolves.toMatchObject({ status: 'error', failure: { code: 'WORKSPACE_POSSESSION_DENIED' } });
    const opening = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginOpen({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-b', expectedGeneration: 2 }));
    expect(opening).toEqual({ status: 'ok', value: { revision: 1, manifestKey: 'projects/project-a/spaces/space-a/checkpoints/1/manifest.enc', manifestHash } });
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.commitOpen({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-b', expectedGeneration: 2, revision: 1 }));
    const opened = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.get());
    expect(opened).toMatchObject({ state: 'open', machineId: 'machine-b', generation: 3 });
  });

  it('returns a failed checkpoint to the existing open generation', async () => {
    const stub = env.SPACE_AUTHORITY.getByName('space-failure');
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.bootstrap({ projectId: 'project-a', spaceId: 'space-failure', machineId: 'machine-a' }));
    const close = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginClose({ projectId: 'project-a', spaceId: 'space-failure', machineId: 'machine-a', expectedGeneration: 1 }));
    if (close.status === 'error') throw new Error(close.failure.message);
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.abortClose({ projectId: 'project-a', spaceId: 'space-failure', machineId: 'machine-a', expectedGeneration: 1, revision: close.value.revision, message: 'upload failed' }));
    const record = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.get());
    expect(record).toMatchObject({ state: 'open', machineId: 'machine-a', generation: 1, checkpointRevision: 1, publishedRevision: 0, failures: { close: { code: 'WORKSPACE_CHECKPOINT_FAILED' } } });
    const retry = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginClose({ projectId: 'project-a', spaceId: 'space-failure', machineId: 'machine-a', expectedGeneration: 1 }));
    expect(retry).toEqual({ status: 'ok', value: { revision: 2, previousRevision: null } });
  });
});
