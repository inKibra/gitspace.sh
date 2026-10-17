import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeAttachmentSchema } from '@gitspace/protocol-runtime';
import { ExecutorJournal } from './journal.js';
import { prepareMachineAttachment } from './attachments.js';
import { CHECKOUT_ACQUIRING_MARKER } from './artifactfs.js';
import type { RunExecutorCommand } from './commands.js';

const runGit: RunExecutorCommand = async command => {
  const child = Bun.spawn(['git', ...command.args], { cwd: command.cwd, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, output: stdout + stderr };
};
const git = async (cwd: string, ...args: string[]) => { if ((await runGit({ application: 'git', args, cwd, attemptId: 'test', sequence: 0, deadlineAt: new Date(Date.now() + 60_000).toISOString(), signal: new AbortController().signal })).exitCode !== 0) throw new Error(`git ${args.join(' ')} failed`); };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'attachments-'));
  const rootPath = join(directory, 'workspace');
  const journal = new ExecutorJournal(join(directory, 'journal.sqlite'));
  const attachment = RuntimeAttachmentSchema.parse({ attachmentId: 'checkout', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, checkout: { kind: 'shared', branch: 'feature' }, state: 'attaching', capabilities: [], updatedAt: new Date().toISOString() });
  // No source: a checkout the attach does not accept as existing reaches acquisition, which then reports the missing source.
  const prepare = () => prepareMachineAttachment(journal, {
    enrolled: { attachment, executionSecret: 'secret' }, source: null, canonicalPath: rootPath,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), signal: new AbortController().signal, prerequisites: async () => {},
  }, runGit);
  /** A checkout with one commit, HEAD detached on it, as acquisition leaves it before the branch step. */
  const detached = async (branches: boolean) => {
    await git(directory, 'init', '-q', '-b', 'source', rootPath);
    await writeFile(join(rootPath, 'file'), 'content');
    await git(rootPath, 'add', 'file');
    await git(rootPath, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'source');
    await git(rootPath, 'checkout', '-q', '--detach');
    if (!branches) await git(rootPath, 'update-ref', '-d', 'refs/heads/source');
  };
  return { directory, rootPath, prepare, detached, close: async () => { journal.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('an acquisition that failed part way is acquired again instead of blocking every attach', async () => {
  const f = await fixture();
  try {
    await f.detached(true);
    await writeFile(join(f.rootPath, '.git', CHECKOUT_ACQUIRING_MARKER), '');
    await expect(f.prepare()).rejects.toThrow('The cloud did not send a source');
    expect(existsSync(f.rootPath)).toBe(false);
  } finally { await f.close(); }
});

test('a checkout left detached without branches by an earlier version is recognised as unfinished', async () => {
  const f = await fixture();
  try {
    await f.detached(false);
    await expect(f.prepare()).rejects.toThrow('The cloud did not send a source');
    expect(existsSync(f.rootPath)).toBe(false);
  } finally { await f.close(); }
});

test('a finished checkout someone detached is kept and named, not removed', async () => {
  const f = await fixture();
  try {
    await f.detached(true);
    await expect(f.prepare()).rejects.toThrow('not on the workspace branch feature (its HEAD is detached)');
    expect(existsSync(f.rootPath)).toBe(true);
  } finally { await f.close(); }
});
