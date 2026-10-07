import { expect, test } from 'vitest';
import { RuntimeAttachmentSchema, RuntimeSnapshotSchema, type RuntimeToolDispatch } from '@gitspace/protocol-runtime';
import { RuntimeServiceInputSchema } from '@gitspace/protocol-runtime/services';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { runtimeServiceControl } from '../src/runtime-service-control.js';

test('service inventory spans caches and actions cannot drift to another machine or generation', async () => {
  const commit = 'a'.repeat(40);
  const checkpoint = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/checkpoint', headCommit: commit, branch: 'main', indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: commit, worktreeTree: commit });
  const attachments = ['a', 'b', 'offline'].map(machineId => RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: `cache-${machineId}`, machineId, generation: 3, role: 'cache', checkout: { kind: 'snapshot', commit }, state: 'ready', capabilities: ['service'], heartbeatAt: machineId === 'offline' ? null : new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const dispatches: RuntimeToolDispatch[] = [];
  const runtime: Parameters<typeof runtimeServiceControl>[0] = {
    snapshot: async () => RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 0, conversations: [{ id: 'main', parentId: null, title: 'Main', status: 'idle', messages: [] }], attachments, tasks: [], questions: [], documents: {} }),
    cloudFiles: { initializeSnapshot: async () => checkpoint },
    attachments: { list: () => attachments, execute: async dispatch => {
      dispatches.push(dispatch);
      const service = { name: 'web', source: 'declared', terminalName: 'web', state: 'ready', url: null };
      return { status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: JSON.stringify(dispatch.args && typeof dispatch.args === 'object' && !Array.isArray(dispatch.args) && dispatch.args.op === 'list' ? [service] : service) }] };
    } },
  };
  const input = { projectId: 'project', workspaceId: 'workspace' };
  const inventory = await runtimeServiceControl(runtime, RuntimeServiceInputSchema.parse({ ...input, command: { op: 'list' } }));
  expect(inventory).toMatchObject({ op: 'list', machines: [{ machineId: 'a', available: true, services: [{ name: 'web' }] }, { machineId: 'b', available: true, services: [{ name: 'web' }] }, { machineId: 'offline', available: false, services: [] }] });
  expect(dispatches.map(item => item.machineId)).toEqual(['a', 'b']);
  await runtimeServiceControl(runtime, RuntimeServiceInputSchema.parse({ ...input, command: { op: 'stop', source: 'declared', name: 'web', machineId: 'b', attachmentId: 'cache-b', generation: 3 } }));
  expect(dispatches.at(-1)).toMatchObject({ machineId: 'b', attachmentId: 'cache-b', generation: 3, args: { op: 'stop', name: 'web' } });
  await expect(runtimeServiceControl(runtime, RuntimeServiceInputSchema.parse({ ...input, command: { op: 'stop', source: 'declared', name: 'web', machineId: 'b', attachmentId: 'cache-b', generation: 2 } }))).rejects.toThrow('attachment changed');
  await expect(runtimeServiceControl(runtime, RuntimeServiceInputSchema.parse({ ...input, command: { op: 'start', source: 'declared', name: 'web', machineId: 'offline', attachmentId: 'cache-offline', generation: 3 } }))).rejects.toThrow('offline');
  expect(dispatches).toHaveLength(3);
});
