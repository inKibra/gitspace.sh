import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachmentSchema, type RuntimeAttachment } from '@gitspace/protocol-runtime';
import { CloudRuntimeClient } from '../src/cloud-runtime-client.js';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';
import { createMachineExecutor, type MachineExecutorRuntime } from '../src/runtime-executor.js';
import { receiveMachineNotices } from '../src/machine-notices.js';
import { ManualWorktreeClock } from './git-worktree-clock.js';

const projectId = 'project';
/** The machine holds attachments in this many workspaces, as the stalled machine did. */
const WORKSPACES = 22;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(stderr);
}

/** A cloud holding one attaching attachment of this machine in each of `WORKSPACES` workspaces. Its machine-wide read
 * never answers (until the read's own deadline), as a stuck workspace object made it. */
async function fleet(workspaceDeadlineMs = 60_000) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-assignments-'));
  const spaces = join(root, 'spaces');
  const attachments = new Map<string, RuntimeAttachment>();
  for (let index = 0; index < WORKSPACES; index++) {
    const workspaceId = `workspace-${index}`;
    attachments.set(workspaceId, RuntimeAttachmentSchema.parse({ projectId, workspaceId, machineId: 'machine', attachmentId: `attachment-${index}`, generation: 0, checkout: { kind: 'shared', branch: 'main' }, state: 'attaching', capabilities: ['read', 'write', 'edit', 'checkpoint'], updatedAt: new Date().toISOString() }));
  }
  /** Each assignments read: the workspace it named, or null for the machine's. */
  const reads: Array<string | null> = [];
  /** Workspaces whose next reads never answer (until the read's own deadline). */
  const hanging = new Set<string>();
  /** Workspaces whose ready announcements the cloud refuses. */
  const refusingReady = new Set<string>();
  const never = (signal: AbortSignal | undefined) => {
    const aborted = Promise.withResolvers<never>();
    signal?.addEventListener('abort', () => aborted.reject(signal.reason), { once: true });
    return aborted.promise;
  };
  const AttachmentRequestSchema = z.object({ attachmentId: z.string() });
  const byAttachment = (payload: Record<string, unknown>) => {
    const { attachmentId } = AttachmentRequestSchema.parse(payload);
    const attachment = [...attachments.values()].find(item => item.attachmentId === attachmentId);
    if (!attachment) throw new Error(`Unknown attachment ${attachmentId}`);
    return attachment;
  };
  class FleetCloud extends CloudRuntimeClient {
    override async call<S extends z.ZodType>(operation: ControlOperation, payload: Record<string, unknown>, schema: S, signal?: AbortSignal): Promise<z.output<S>> {
      if (operation === 'runtime.assignments') {
        const { workspace } = z.object({ workspace: z.object({ projectId: z.string(), workspaceId: z.string() }).optional() }).parse(payload);
        reads.push(workspace?.workspaceId ?? null);
        if (!workspace || hanging.has(workspace.workspaceId)) await never(signal);
        const listed = [...attachments.values()].filter(item => item.state !== 'detached' && (!workspace || item.workspaceId === workspace.workspaceId));
        return schema.parse({ assignments: listed.map(attachment => ({ grant: { attachment, executionSecret: 'secret' }, source: null })) });
      }
      if (operation === 'runtime.attachment.ready') {
        const attachment = byAttachment(payload);
        if (refusingReady.has(attachment.workspaceId)) throw new Error('internal error; reference = ready refused');
        const ready = { ...attachment, state: 'ready' as const };
        attachments.set(attachment.workspaceId, ready);
        return schema.parse({ attachment: ready });
      }
      if (operation === 'runtime.attachment.cache.request') return schema.parse({});
      if (operation === 'runtime.heartbeat') return schema.parse({ attachment: byAttachment(payload) });
      if (operation === 'runtime.checkouts.retired') return schema.parse({ retired: [] });
      throw new Error(`Unexpected operation: ${operation}`);
    }
  }
  const unavailable = async (): Promise<never> => { throw new Error('External service forbidden'); };
  class LocalGitRemote extends ArtifactsGitRemote {
    override async publishCheckpoint() {}
  }
  const clock = new ManualWorktreeClock();
  const runtime: MachineExecutorRuntime = await createMachineExecutor({
    environmentRoot: join(root, 'runtime'), managedSpaceRoot: spaces, machineId: 'machine',
    cloud: new FleetCloud({ baseUrl: 'https://assignments.invalid', userId: 'account', machineId: 'machine', signingPrivateKey: new Uint8Array(32) }),
    gitRemote: new LocalGitRemote({ credentials: unavailable }), prepareAttachment: async () => {},
    commitSnapshot: async (_local, candidate) => candidate,
    originEnvironment: async () => ({}),
    checkpointClock: clock, checkpointEvents: () => () => {},
    assignmentsReadDeadlines: { machine: 60_000, workspace: workspaceDeadlineMs },
  });
  cleanups.push(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return {
    runtime, clock, reads, hanging, refusingReady,
    /** Puts a checkout on disk for the workspace, so its attach can complete. */
    checkout: async (workspaceId: string) => {
      const path = join(spaces, projectId, workspaceId);
      await mkdir(path, { recursive: true });
      await git(path, 'init', '-b', 'main');
      await git(path, 'config', 'user.name', 'Assignments proof');
      await git(path, 'config', 'user.email', 'proof@example.invalid');
      await writeFile(join(path, 'tracked.txt'), `${workspaceId}\n`);
      await git(path, 'add', '.');
      await git(path, 'commit', '-m', 'base');
    },
    /** The machine's own record of the workspace's attachment. */
    local: (workspaceId: string) => runtime.journal.attachments().find(item => item.attachment.workspaceId === workspaceId)?.attachment.state ?? null,
    cloudState: (workspaceId: string) => attachments.get(workspaceId)?.state,
  };
}

test('an assignments notice naming a workspace attaches it with one read of that workspace, while the machine-wide read hangs', async () => {
  const { runtime, clock, reads, checkout, local, cloudState } = await fleet();
  await checkout('workspace-7');
  // The startup catch-up is machine-wide, and hangs.
  expect(reads).toEqual([null]);
  reads.length = 0;
  const work: Array<Promise<void>> = [];
  receiveMachineNotices([{ topics: ['assignments'], workspaceId: 'workspace-7', projectId }], {
    projectOf: () => null,
    assignments: workspace => { const read = runtime.sync(workspace ?? undefined); work.push(read); return read; },
    snapshot: async () => {}, release: async () => {}, devices: () => {}, settings: async () => {}, environment: () => {},
    failed: (topic, error) => { throw new Error(`${topic}: ${String(error)}`); },
  });
  await clock.until(Promise.all(work), 8_000);
  expect(reads).toEqual(['workspace-7']);
  expect(local('workspace-7')).toBe('ready');
  expect(cloudState('workspace-7')).toBe('ready');
}, 15_000);

test('a workspace read never releases another workspace\'s checkout', async () => {
  const { runtime, clock, reads, checkout, local } = await fleet();
  await checkout('workspace-1');
  await checkout('workspace-2');
  await clock.until(runtime.sync({ projectId, workspaceId: 'workspace-1' }), 8_000);
  expect(local('workspace-1')).toBe('ready');
  reads.length = 0;
  // workspace-2's assignments do not list workspace-1's attachment.
  await clock.until(runtime.sync({ projectId, workspaceId: 'workspace-2' }), 8_000);
  expect(reads).toEqual(['workspace-2']);
  expect(local('workspace-2')).toBe('ready');
  expect(local('workspace-1')).toBe('ready');
}, 15_000);

test('using a workspace whose assignments read timed out says which read failed, when, and that it is read again', async () => {
  const { runtime, clock, reads, hanging, refusingReady, checkout, local } = await fleet(50);
  await checkout('workspace-3');
  // The attach fails at its last step, so the machine holds the attachment while it is not ready.
  refusingReady.add('workspace-3');
  await clock.until(runtime.sync({ projectId, workspaceId: 'workspace-3' }), 8_000);
  expect(local('workspace-3')).toBe('attaching');
  hanging.add('workspace-3');
  reads.length = 0;
  const used = runtime.useWorkspace('workspace-3');
  await expect(clock.until(used, 8_000)).rejects.toThrow(/The workspace checkout on this machine is not ready: .*the machine's assignments read for this workspace failed at \d{4}-\d\d-\d\dT[\d:.]+Z: Reading the assignments of workspace workspace-3 timed out after 0\.05 s; the next use of the workspace reads them again/u);
  // The use read that workspace alone, never waiting on the machine-wide read that still hangs.
  expect(reads).toEqual(['workspace-3']);
}, 15_000);
