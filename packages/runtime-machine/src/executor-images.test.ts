import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { MachineExecutor, type MachineExecutorOptions } from './executor.js';
import { ExecutorJournal } from './journal.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function run(storeImage: NonNullable<MachineExecutorOptions['storeImage']>) {
  const root = await mkdtemp(join(tmpdir(), 'executor-images-'));
  directories.push(root);
  const journal = new ExecutorJournal(join(root, 'journal.sqlite'));
  journal.installAttachment({
    attachment: RuntimeAttachmentSchema.parse({
      projectId: 'project-a', workspaceId: 'workspace-a', attachmentId: 'attachment-a', machineId: 'machine-a', generation: 1,
      checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: ['browser'], updatedAt: new Date().toISOString(), online: true, failure: null,
    }),
    rootPath: root, executionSecret: Buffer.from('s'.repeat(32)).toString('base64url'), prerequisitesComplete: true,
  });
  // A screenshot, as the machine browser returns one.
  const executor = new MachineExecutor({
    machineId: 'machine-a', journal, runCommand: async () => ({ exitCode: 0, output: '' }), storeImage,
    operations: { browser: async () => [{ type: 'text', text: 'Shot' }, { type: 'image', data: 'AAEC', mimeType: 'image/png' }] },
  });
  return executor.execute(RuntimeToolDispatchSchema.parse({
    version: 1, projectId: 'project-a', workspaceId: 'workspace-a', machineId: 'machine-a', attachmentId: 'attachment-a', generation: 1,
    conversationId: 'conversation-a', conversationKind: 'main', taskId: 'task-a', requestId: 'request-a', attemptId: 'attempt-a',
    tool: 'browser', args: {}, replay: 'unsafe', deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  }));
}

test('a tool\'s image leaves the machine as the reference its workspace stored it under', async () => {
  const stored: string[] = [];
  const result = await run(async (dispatch, image) => { stored.push(`${dispatch.workspaceId}:${image.data}`); return { ...image, data: 'gs-image:v1:workspace-a:3:0x0:' + 'a'.repeat(64) }; });
  expect(stored).toEqual(['workspace-a:AAEC']);
  expect(result).toMatchObject({ status: 'completed', content: [{ type: 'text', text: 'Shot' }, { type: 'image', data: 'gs-image:v1:workspace-a:3:0x0:' + 'a'.repeat(64), mimeType: 'image/png' }] });
});

test('a tool whose image could not be stored fails, rather than sending the image', async () => {
  const result = await run(async () => { throw new Error('Storage refused the image'); });
  expect(result).toMatchObject({ status: 'failed', content: [], error: { message: 'Storage refused the image' } });
});
