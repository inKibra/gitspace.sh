import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { ExecutorJournal } from './journal.js';
import { prepareMachineAttachment, cleanupMachineAttachment } from './attachments.js';

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(error);
  return output.trim();
}

test('equal cache acquisition uses canonical path, runs setup, and retains unrelated checkout', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cache-attachment-'));
  const journal = new ExecutorJournal(join(directory, 'journal.sqlite'));
  try {
    const source = join(directory, 'source');
    await mkdir(source);
    await git(source, 'init', '-b', 'main');
    await git(source, 'config', 'user.name', 'Cache proof');
    await git(source, 'config', 'user.email', 'proof@example.invalid');
    await writeFile(join(source, 'work'), 'canonical');
    await git(source, 'add', '.');
    await git(source, 'commit', '-m', 'base');
    const attachment = RuntimeAttachmentSchema.parse({ attachmentId: 'cache', projectId: 'project', workspaceId: 'workspace', machineId: 'machine-b', generation: 1, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'attaching', capabilities: [], updatedAt: new Date().toISOString() });
    attachment.cache = { state: 'live', platform: process.platform, activity: [], lastActivityAt: new Date().toISOString(), pausedAt: null, reclaimAt: null, lastSyncAt: null, localWorkOptIn: false, reclaimBlocked: null, setup: [] };
    const canonicalPath = join(directory, 'project', 'workspace');
    const prepared: string[] = [];
    const local = await prepareMachineAttachment(journal, { enrolled: { attachment, executionSecret: 'secret' }, source: { kind: 'local', repository: source }, checkoutRoot: directory, canonicalPath, deadlineAt: new Date(Date.now() + 30000).toISOString(), signal: new AbortController().signal, prerequisites: async local => { prepared.push(local.rootPath); } });
    expect(local.rootPath).toBe(canonicalPath);
    expect(prepared).toEqual([canonicalPath]);
    expect(await readFile(join(canonicalPath, 'work'), 'utf8')).toBe('canonical');
    const input = { attachment: { ...local.attachment, state: 'draining' as const }, checkoutRoot: directory, canonicalPath, signal: new AbortController().signal, stopAndVerify: async () => { throw new Error('held-back LFS'); }, verifyUnmounted: async () => {} };
    await expect(cleanupMachineAttachment(journal, input)).rejects.toThrow('held-back LFS');
    expect(await readFile(join(canonicalPath, 'work'), 'utf8')).toBe('canonical');
    const effect = RuntimeToolDispatchSchema.parse({ version: 1, conversationKind: 'main', conversationId: 'proof', taskId: 'proof', projectId: 'project', workspaceId: 'workspace', machineId: 'machine-b', attachmentId: 'cache', generation: 1, requestId: 'effect', attemptId: 'effect', tool: 'bash', args: { command: 'effect' }, replay: 'unsafe', deadlineAt: new Date(Date.now() + 30000).toISOString() });
    journal.begin(effect);
    await expect(cleanupMachineAttachment(journal, { ...input, stopAndVerify: async () => {} })).rejects.toThrow('unresolved');
    expect(await readFile(join(canonicalPath, 'work'), 'utf8')).toBe('canonical');
    journal.fence(effect);
    await cleanupMachineAttachment(journal, { ...input, stopAndVerify: async () => {} });
    expect(await Bun.file(join(canonicalPath, 'work')).exists()).toBe(false);
    expect(await readFile(join(source, 'work'), 'utf8')).toBe('canonical');
    expect(journal.attachment('cache')?.attachment.cache?.state).toBe('reclaimed');
    await writeFile(join(source, 'work'), 'new cloud contents');
    await git(source, 'commit', '-am', 'cloud update');
    const recovered = await prepareMachineAttachment(journal, {
      enrolled: { attachment: { ...attachment, cacheAction: { requestId: 'rehydrate', action: 'setup', status: 'requested', error: null } }, executionSecret: 'secret' },
      source: { kind: 'local', repository: source }, checkoutRoot: directory, canonicalPath,
      deadlineAt: new Date(Date.now() + 30000).toISOString(), signal: new AbortController().signal,
      prerequisites: async local => { prepared.push(local.rootPath); },
    });
    expect(recovered.rootPath).toBe(canonicalPath);
    expect(prepared).toEqual([canonicalPath, canonicalPath]);
    expect(await readFile(join(canonicalPath, 'work'), 'utf8')).toBe('new cloud contents');
  } finally { journal.close(); await rm(directory, { recursive: true, force: true }); }
});
