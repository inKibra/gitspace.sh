import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutorJournal, type LocalAttachment } from './journal.js';
import { stageProposal, resolveProposal } from './ast-proposals.js';
import { cleanupMachineAttachment } from './attachments.js';
import { RuntimeToolDispatchSchema, RuntimeAttachmentSchema } from '@gitspace/protocol-runtime';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cleanup-proposals-'));
  const root = join(directory, Buffer.from('runner').toString('base64url'));
  await mkdir(root);
  const journal = new ExecutorJournal(join(directory, 'journal.sqlite'));
  const local: LocalAttachment = { attachment: RuntimeAttachmentSchema.parse({ attachmentId: 'runner', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, role: 'runner', checkout: { kind: 'snapshot', commit: 'a'.repeat(40) }, state: 'ready', capabilities: [], updatedAt: new Date().toISOString() }), rootPath: root, executionSecret: 'secret', prerequisitesComplete: true };
  journal.installAttachment(local);
  return { directory, root, journal, local, signal: new AbortController().signal, close: async () => { journal.close(); await rm(directory, { recursive: true, force: true }); } };
}
test('AST resolution preflights all sources, binds generation, and safely repeats resolution', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a.ts'), 'before');
    await writeFile(join(f.root, 'b.ts'), 'before');
    const id = stageProposal(f.journal, f.local, 'attempt', ['a.ts', 'b.ts'].map(path => ({ path, before: 'before', after: 'after' })));
    expect(await readFile(join(f.root, 'a.ts'), 'utf8')).toBe('before');
    await writeFile(join(f.root, 'b.ts'), 'conflict');
    await expect(resolveProposal(f.journal, f.local, id, 'apply', f.signal)).rejects.toThrow('source changed');
    expect(await readFile(join(f.root, 'a.ts'), 'utf8')).toBe('before');
    await writeFile(join(f.root, 'b.ts'), 'before');
    await expect(resolveProposal(f.journal, { ...f.local, attachment: { ...f.local.attachment, generation: 2 } }, id, 'apply', f.signal)).rejects.toThrow('generation');
    expect(await resolveProposal(f.journal, f.local, id, 'apply', f.signal)).toBe('applied');
    expect(await resolveProposal(f.journal, f.local, id, 'apply', f.signal)).toBe('applied');
    expect(await readFile(join(f.root, 'a.ts'), 'utf8')).toBe('after');
    await expect(resolveProposal(f.journal, f.local, id, 'reject', f.signal)).rejects.toThrow('differently');
  } finally { await f.close(); }
});
test('AST reject never changes files and forged or symlink proposals cannot mutate', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, 'outside'), 'private');
    await symlink(join(f.directory, 'outside'), join(f.root, 'link'));
    const id = stageProposal(f.journal, f.local, 'attempt', [{ path: 'link', before: 'private', after: 'bad' }]);
    await expect(resolveProposal(f.journal, f.local, id, 'apply', f.signal)).rejects.toThrow('symlink');
    expect(await resolveProposal(f.journal, f.local, id, 'reject', f.signal)).toBe('rejected');
    expect(await resolveProposal(f.journal, f.local, id, 'reject', f.signal)).toBe('rejected');
    await expect(resolveProposal(f.journal, f.local, 'f'.repeat(64), 'apply', f.signal)).rejects.toThrow('Unknown');
    expect(await readFile(join(f.directory, 'outside'), 'utf8')).toBe('private');
  } finally { await f.close(); }
});
test('cleanup retains work on unverified stop and retries after deletion before cloud acknowledgement', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'work'), 'keep');
    const input = { attachment: { ...f.local.attachment, state: 'draining' as const }, checkoutRoot: f.directory, signal: f.signal, stopAndVerify: async () => { throw new Error('process remains'); }, verifyUnmounted: async () => {} };
    await expect(cleanupMachineAttachment(f.journal, input)).rejects.toThrow('process remains');
    expect(await readFile(join(f.root, 'work'), 'utf8')).toBe('keep');
    expect(f.journal.attachment('runner')?.attachment.state).toBe('draining');
    const retry = { ...input, stopAndVerify: async () => {} };
    expect((await cleanupMachineAttachment(f.journal, retry)).attachment.state).toBe('detached');
    expect((await cleanupMachineAttachment(f.journal, retry)).attachment.state).toBe('detached');
  } finally { await f.close(); }
});

test('cleanup refuses unresolved effects and forged primary scope', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'work'), 'keep');
    const input = { attachment: { ...f.local.attachment, state: 'draining' as const }, checkoutRoot: f.directory, signal: f.signal, stopAndVerify: async () => {}, verifyUnmounted: async () => {} };
    await expect(cleanupMachineAttachment(f.journal, { ...input, attachment: { ...input.attachment, role: 'primary' } })).rejects.toThrow();
    f.journal.begin(RuntimeToolDispatchSchema.parse({
      version: 1, projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'runner', generation: 1,
      conversationId: 'conversation', taskId: 'task', requestId: 'request', attemptId: 'attempt', tool: 'bash', args: { command: 'effect' },
      deadlineAt: new Date(Date.now() + 60_000).toISOString(), replay: 'unsafe',
    }));
    await expect(cleanupMachineAttachment(f.journal, input)).rejects.toThrow('unresolved');
    expect(await readFile(join(f.root, 'work'), 'utf8')).toBe('keep');
  } finally { await f.close(); }
});

test('primary drain preserves shared files and failed cleanup cannot acknowledge detach', async () => {
  const f = await fixture();
  try {
    const primary: LocalAttachment = { ...f.local, attachment: { ...f.local.attachment, role: 'primary', checkout: { kind: 'shared', branch: 'main' }, ownershipGeneration: 7 } };
    f.journal.installAttachment(primary);
    await writeFile(join(f.root, 'work'), 'shared work');
    const input = { attachment: { ...primary.attachment, state: 'draining' as const }, checkoutRoot: '/not-a-private-checkout', signal: f.signal, stopAndVerify: async () => { throw new Error('process still running'); }, verifyUnmounted: async () => { throw new Error('must not unmount shared checkout'); } };
    await expect(cleanupMachineAttachment(f.journal, input)).rejects.toThrow('process still running');
    expect(f.journal.attachment('runner')?.attachment.state).toBe('draining');
    expect(await readFile(join(f.root, 'work'), 'utf8')).toBe('shared work');
    await expect(cleanupMachineAttachment(f.journal, { ...input, attachment: { ...input.attachment, ownershipGeneration: 8 } })).rejects.toThrow();
    await expect(cleanupMachineAttachment(f.journal, { ...input, attachment: { ...input.attachment, generation: 2 } })).rejects.toThrow();
    const retry = { ...input, stopAndVerify: async () => {} };
    expect((await cleanupMachineAttachment(f.journal, retry)).attachment.state).toBe('detached');
    expect((await cleanupMachineAttachment(f.journal, retry)).attachment.state).toBe('detached');
    expect(await readFile(join(f.root, 'work'), 'utf8')).toBe('shared work');
  } finally { await f.close(); }
});

test('AST recovery resumes applied files and rejects a torn preimage without further mutation', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'a.ts'), 'before');
    await writeFile(join(f.root, 'b.ts'), 'before');
    const id = stageProposal(f.journal, f.local, 'recovery', ['a.ts', 'b.ts'].map(path => ({ path, before: 'before', after: 'after' })));
    const proposal = f.journal.proposal(id) as { scope: string; changes: unknown[] };
    f.journal.saveProposal(id, { ...proposal, state: 'applying' });
    await writeFile(join(f.root, 'a.ts'), 'after');
    await writeFile(join(f.root, 'b.ts'), 'torn');
    await expect(resolveProposal(f.journal, f.local, id, 'reject', f.signal)).rejects.toThrow('partial');
    await expect(resolveProposal(f.journal, f.local, id, 'apply', f.signal)).rejects.toThrow('source changed');
    expect(await readFile(join(f.root, 'a.ts'), 'utf8')).toBe('after');
    await writeFile(join(f.root, 'b.ts'), 'before');
    expect(await resolveProposal(f.journal, f.local, id, 'apply', f.signal)).toBe('applied');
    expect(await readFile(join(f.root, 'b.ts'), 'utf8')).toBe('after');
  } finally { await f.close(); }
});
