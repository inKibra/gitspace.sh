import { expect, test } from 'bun:test';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import type { LifecycleRun, LifecycleRunRequest } from '@gitspace/protocol-environment';
import { machineOperationalTools } from '../src/runtime-operations.js';

const unexpected = (): never => { throw new Error('Unexpected dependency access'); };

test('merge rejects a runner with cache terminology before any integration effect', async () => {
  const operations = machineOperationalTools({
    get environments() { return unexpected(); }, get services() { return unexpected(); },
    get authority() { return unexpected(); },
    get artifacts() { return unexpected(); }, get mcp() { return unexpected(); }, journal: unexpected,
  });
  const attachment = RuntimeAttachmentSchema.parse({
    projectId: 'project', workspaceId: 'workspace', attachmentId: 'runner', machineId: 'machine',
    generation: 1, ownershipGeneration: 1, role: 'runner', checkout: { kind: 'snapshot', commit: 'a'.repeat(40) },
    state: 'ready', capabilities: ['read'], updatedAt: new Date().toISOString(),
  });
  const dispatch = RuntimeToolDispatchSchema.parse({
    version: 1, projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'runner',
    generation: 1, conversationId: 'conversation', conversationKind: 'main', taskId: 'task', requestId: 'request',
    attemptId: 'attempt', tool: 'merge', args: { expectedPrimaryCommit: 'a'.repeat(40), commit: 'b'.repeat(40) },
    deadlineAt: new Date(Date.now() + 30_000).toISOString(), replay: 'unsafe',
  });
  const result = await operations.merge!(dispatch, { attachment, rootPath: '/unused-runner', executionSecret: 'secret', prerequisitesComplete: true }, new AbortController().signal).then(
    () => { throw new Error('Runner merge unexpectedly succeeded'); },
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  if (!(result instanceof Error)) throw new Error('Merge did not return an error');
  expect(result.message).toMatch(/cache/i);
  expect(result.message).not.toMatch(/\b(primary|replicas?)\b/i);
});

test('a cache accepts the human run the account authorized, including interactive and cloud destruction runs', async () => {
  const run: LifecycleRun = {
    id: 'run', projectId: 'project', spaceId: 'workspace', phase: 'cloud/destroy', status: 'accepted', profile: 'base', machineId: 'machine', generation: 1,
    executionHashes: [], terminalName: null, results: [], output: '', exitCode: null, startedAt: new Date().toISOString(), finishedAt: null,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), cancelRequestedAt: null, failure: null, incidents: [],
  };
  const accepted: Array<{ spaceId: string; request: LifecycleRunRequest }> = [];
  const operations = machineOperationalTools({
    environments: { async acceptRun(spaceId, request) { accepted.push({ spaceId, request }); return run; } },
    get services() { return unexpected(); }, get authority() { return unexpected(); },
    get artifacts() { return unexpected(); }, get mcp() { return unexpected(); }, journal: unexpected,
  });
  const attachment = RuntimeAttachmentSchema.parse({
    projectId: 'project', workspaceId: 'workspace', attachmentId: 'cache', machineId: 'machine',
    generation: 1, ownershipGeneration: 1, role: 'cache', checkout: { kind: 'shared', branch: 'main' },
    state: 'ready', capabilities: [], updatedAt: new Date().toISOString(),
  });
  const local = { attachment, rootPath: '/cache', executionSecret: 'secret', prerequisitesComplete: true };
  for (const args of [{ runId: 'destroy', phase: 'cloud/destroy', on: 'machine' }, { runId: 'login', phase: 'machine/prepare', interactive: true, on: 'machine' }]) {
    const dispatch = RuntimeToolDispatchSchema.parse({
      version: 1, projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'cache',
      generation: 1, conversationId: 'conversation', conversationKind: 'main', taskId: 'task', requestId: args.runId,
      attemptId: args.runId, tool: 'lifecycle', args, deadlineAt: new Date(Date.now() + 30_000).toISOString(), replay: 'unsafe',
    });
    expect(await operations.lifecycle!(dispatch, local, new AbortController().signal)).toEqual([{ type: 'text', text: JSON.stringify(run) }]);
  }
  expect(accepted).toEqual([
    { spaceId: 'workspace', request: { runId: 'destroy', phase: 'cloud/destroy' } },
    { spaceId: 'workspace', request: { runId: 'login', phase: 'machine/prepare', interactive: true } },
  ]);
});
