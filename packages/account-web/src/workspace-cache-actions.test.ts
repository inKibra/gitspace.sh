import { expect, it, vi } from 'vitest';
import { RuntimeAttachmentSchema, RuntimeSnapshotSchema, type RuntimeAttachment } from '@gitspace/protocol-runtime';
import { releaseWorkspaceCaches } from './workspace-cache-actions.js';

const stamp = '2026-10-09T00:00:00.000Z';
function attachment(id: string, fields: Partial<RuntimeAttachment> = {}) {
  return RuntimeAttachmentSchema.parse({
    projectId: 'project', workspaceId: 'workspace', attachmentId: id, machineId: id, generation: 7,
    checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: stamp,
    ...fields,
  });
}
function snapshot(attachments: RuntimeAttachment[]) {
  return RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', cursor: 1, conversations: [], tasks: [], questions: [], documents: {}, attachments });
}

it('does not begin a partial release before the user resolves held-back machine changes', async () => {
  const value = snapshot([attachment('first'), attachment('second')]);
  const commit = 'a'.repeat(40);
  value.documents['gitspace.code'] = { checkpointRef: 'refs/gitspace/checkpoint', headCommit: commit, branch: 'main', indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: commit, worktreeTree: commit, lfs: { objects: [], heldBack: [{ path: 'local.mov', kind: 'added' }] } };
  const decision = Promise.withResolvers<boolean>();
  const confirm = vi.fn(() => decision.promise);
  const detach = vi.fn(async () => {});
  const release = releaseWorkspaceCaches(value, confirm, () => {}, detach);
  expect(confirm.mock.calls).toHaveLength(1);
  expect(detach).not.toHaveBeenCalled();
  decision.resolve(false);
  await release;
  expect(detach).not.toHaveBeenCalled();
});

it('stops a multi-cache release on an authority rejection rather than concealing a partial result', async () => {
  const value = snapshot([attachment('first'), attachment('second')]);
  const rejected = new Error('Attachment generation changed');
  const requested: string[] = [];
  await expect(releaseWorkspaceCaches(value, async () => true, () => {}, async input => {
    requested.push(input.attachmentId);
    throw rejected;
  })).rejects.toBe(rejected);
  expect(requested).toEqual(['first']);
});
