import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { SpaceAuthorityDO } from '../src/space-authority.js';

const manifestHash = `sha256:${'a'.repeat(64)}`;

describe('SpaceAuthorityDO', () => {
  it('fences generations across durable close and reopen', async () => {
    const stub = env.SPACE_AUTHORITY.getByName('space-a');
    const initial = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.bootstrap({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-a' }));
    expect(initial).toMatchObject({ state: 'open', machineId: 'machine-a', generation: 1, checkpointRevision: 0 });
    const close = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginClose({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-a', expectedGeneration: 1 }));
    expect(close).toEqual({ revision: 1, previousRevision: null });
    await expect(runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.commitClosed({ projectId: 'project-a', spaceId: 'space-a', machineId: 'stale-machine', expectedGeneration: 1, revision: 1, manifestKey: 'projects/project-a/spaces/space-a/checkpoints/1/manifest.enc', manifestHash }))).rejects.toThrow('expected machine generation');
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.commitClosed({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-a', expectedGeneration: 1, revision: 1, manifestKey: 'projects/project-a/spaces/space-a/checkpoints/1/manifest.enc', manifestHash }));
    const closed = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.get());
    expect(closed).toMatchObject({ state: 'closed', machineId: null, generation: 2, checkpointRevision: 1 });
    await expect(runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginOpen({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-b', expectedGeneration: 1 }))).rejects.toThrow('expected generation');
    const opening = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginOpen({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-b', expectedGeneration: 2 }));
    expect(opening).toEqual({ revision: 1, manifestKey: 'projects/project-a/spaces/space-a/checkpoints/1/manifest.enc', manifestHash });
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.commitOpen({ projectId: 'project-a', spaceId: 'space-a', machineId: 'machine-b', expectedGeneration: 2, revision: 1 }));
    const opened = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.get());
    expect(opened).toMatchObject({ state: 'open', machineId: 'machine-b', generation: 3 });
  });

  it('returns a failed checkpoint to the existing open generation', async () => {
    const stub = env.SPACE_AUTHORITY.getByName('space-failure');
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.bootstrap({ projectId: 'project-a', spaceId: 'space-failure', machineId: 'machine-a' }));
    const close = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginClose({ projectId: 'project-a', spaceId: 'space-failure', machineId: 'machine-a', expectedGeneration: 1 }));
    await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.abortClose({ projectId: 'project-a', spaceId: 'space-failure', machineId: 'machine-a', expectedGeneration: 1, revision: close.revision, message: 'upload failed' }));
    const record = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.get());
    expect(record).toMatchObject({ state: 'open', machineId: 'machine-a', generation: 1, checkpointRevision: 1, errorMessage: 'upload failed' });
    const retry = await runInDurableObject(stub, (instance: SpaceAuthorityDO) => instance.beginClose({ projectId: 'project-a', spaceId: 'space-failure', machineId: 'machine-a', expectedGeneration: 1 }));
    expect(retry).toEqual({ revision: 2, previousRevision: 1 });
  });
});
