import { expect, test } from 'bun:test';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { machineOperationalTools } from '../src/runtime-operations.js';

const unexpected = (): never => { throw new Error('Unexpected dependency access'); };

test('merge rejects a runner with cache terminology before any integration effect', async () => {
  const operations = machineOperationalTools({
    get environments() { return unexpected(); }, get services() { return unexpected(); },
    get authority() { return unexpected(); }, get controls() { return unexpected(); },
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
