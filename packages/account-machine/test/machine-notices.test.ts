import { afterEach, expect, jest, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { RELAY_NOTICE_TOPICS, type ControlOperation, type DeploymentStatus, type RelayNotice } from '@gitspace/protocol';
import { CloudRuntimeClient } from '../src/cloud-runtime-client.js';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';
import { createMachineExecutor, type MachineExecutorRuntime } from '../src/runtime-executor.js';
import { receiveMachineNotices, type MachineNoticeTargets } from '../src/machine-notices.js';
import { ReleaseFollower } from '../src/release-follower.js';

const settle = () => new Promise<void>(resolve => setImmediate(resolve));
const unavailable = async (): Promise<never> => { throw new Error('External service forbidden'); };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  jest.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
/** Far longer than any interval the machine ever polled on. */
const IDLE_MS = 10 * 60_000;
/** Stacks of the recurring timers GitSpace code schedules; runtime internals (an HTTP server's connection sweep) are
 * not ours. */
function gitspaceIntervals(): string[] {
  const original = globalThis.setInterval;
  const scheduled: string[] = [];
  globalThis.setInterval = new Proxy(original, {
    apply(target, thisArg, args) {
      const stack = new Error().stack ?? '';
      if (/packages\/(account-machine|runtime-machine)\/src\//u.test(stack)) scheduled.push(stack);
      return Reflect.apply(target, thisArg, args);
    },
  });
  cleanups.push(async () => { globalThis.setInterval = original; });
  return scheduled;
}

/** An executor whose machine-wide assignment reads are counted and answered only when the test says so. */
async function countedExecutor() {
  const root = await mkdtemp(join(tmpdir(), 'machine-notices-'));
  const reads: Array<PromiseWithResolvers<void>> = [];
  class CountingCloud extends CloudRuntimeClient {
    override async call<S extends z.ZodType>(operation: ControlOperation, payload: Record<string, unknown>, schema: S): Promise<z.output<S>> {
      if (operation !== 'runtime.assignments' || payload.workspace !== undefined) throw new Error(`Unexpected operation: ${operation}`);
      const read = Promise.withResolvers<void>();
      reads.push(read);
      await read.promise;
      return schema.parse({ assignments: [] });
    }
  }
  const runtime: MachineExecutorRuntime = await createMachineExecutor({
    environmentRoot: join(root, 'runtime'), managedSpaceRoot: join(root, 'spaces'), machineId: 'machine',
    cloud: new CountingCloud({ baseUrl: 'https://notices.invalid', userId: 'account', machineId: 'machine', signingPrivateKey: new Uint8Array(32) }),
    gitRemote: new ArtifactsGitRemote({ credentials: unavailable }), prepareAttachment: async () => {},
    commitSnapshot: unavailable,
  });
  cleanups.push(async () => {
    for (const read of reads) read.resolve();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });
  return { runtime, reads };
}

function targets(overrides: Partial<MachineNoticeTargets>): MachineNoticeTargets {
  return {
    assignments: async () => {}, snapshot: async () => {}, release: async () => {}, devices: () => {}, settings: async () => {}, environment: () => {},
    failed: (topic, error) => { throw new Error(`${topic}: ${String(error)}`); },
    ...overrides,
  };
}

test('assignments are read at startup and on notices only: a notice costs one read, notices during a read one more', async () => {
  const intervals = gitspaceIntervals();
  const { runtime, reads } = await countedExecutor();
  await settle();
  // Startup reads once and schedules nothing recurring.
  expect(reads).toHaveLength(1);
  expect(intervals).toEqual([]);
  reads[0]!.resolve();
  await settle();
  const deliver = (notices: RelayNotice[]) => receiveMachineNotices(notices, targets({ assignments: () => runtime.sync(), snapshot: () => runtime.refreshWorkspace('unused') }));
  // Every topic at once (the reconnect catch-up): one machine-wide read also covers every workspace snapshot.
  deliver([{ topics: [...RELAY_NOTICE_TOPICS] }, { topics: ['workspace.snapshot'], workspaceId: 'workspace-a' }]);
  await settle();
  expect(reads).toHaveLength(2);
  for (let index = 0; index < 5; index++) deliver([{ topics: ['assignments'], workspaceId: `workspace-${index}` }]);
  await settle();
  expect(reads).toHaveLength(2);
  reads[1]!.resolve();
  await settle();
  expect(reads).toHaveLength(3);
  reads[2]!.resolve();
  await settle();
  expect(reads).toHaveLength(3);
  expect(intervals).toEqual([]);
});

test('a release notice nudges the follower to read deployment status once; nothing else reads it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'machine-notices-release-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  jest.useFakeTimers();
  const statuses: Array<PromiseWithResolvers<DeploymentStatus>> = [];
  const status: DeploymentStatus = {
    launch: null, desired: { worker: null, machine: null, frontend: null, updatedAt: new Date(0).toISOString() },
    current: { worker: { sha: null, version: null }, machines: {} }, releases: [],
  };
  const follower = new ReleaseFollower({
    authority: {
      deploymentStatus: () => { const read = Promise.withResolvers<DeploymentStatus>(); statuses.push(read); return read.promise; },
      reportMachineApplied: unavailable, reportMachineChannelApplied: async () => {},
      machineProtocol: async () => ({ version: 1, required: 1 as const, state: 'ready' as const, releaseSha: null, error: null }),
    },
    blobs: { get: async () => null }, machineId: 'machine', environmentRoot: root,
    hostUrl: null, controlToken: null, runningMachineSha: null, generation: null,
    onError: error => { throw error; },
  });
  const started = follower.start();
  await settle();
  expect(statuses).toHaveLength(1);
  // Release notices during the startup pass share one follow-up pass.
  receiveMachineNotices([{ topics: ['release'] }], targets({ release: () => follower.nudge() }));
  receiveMachineNotices([{ topics: ['release', 'devices'] }], targets({ release: () => follower.nudge() }));
  statuses[0]!.resolve(status);
  await started;
  await settle();
  expect(statuses).toHaveLength(2);
  statuses[1]!.resolve(status);
  await settle();
  jest.advanceTimersByTime(IDLE_MS);
  await settle();
  expect(statuses).toHaveLength(2);
});
