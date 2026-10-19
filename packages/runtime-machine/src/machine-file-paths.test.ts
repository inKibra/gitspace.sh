import { afterEach, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { executeMachineTool, type MachineToolOptions } from './tools.js';

const roots: string[] = [];
const options: MachineToolOptions = { runCommand: command => {
  const { promise, resolve } = Promise.withResolvers<{ exitCode: number; output: string }>();
  execFile(command.application, command.args, { cwd: command.cwd, env: command.env ?? {} }, (error, stdout, stderr) => {
    resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, output: stdout + stderr });
  });
  return promise;
} };

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function scratch(prefix: string, parent = '/tmp') {
  const directory = await mkdtemp(join(parent, prefix));
  roots.push(directory);
  return directory;
}

async function run(rootPath: string, tool: string, args: Record<string, unknown>) {
  const attachment = RuntimeAttachmentSchema.parse({ attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: ['read', 'write', 'edit', 'bash'], updatedAt: new Date().toISOString() });
  const dispatch = RuntimeToolDispatchSchema.parse({ conversationKind: 'main', version: 1, conversationId: 'conversation', taskId: 'task', attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, requestId: 'request', attemptId: 'attempt', tool, args, deadlineAt: new Date(Date.now() + 60_000).toISOString(), replay: 'unsafe' });
  const content = await executeMachineTool(dispatch, { attachment, rootPath, executionSecret: 'unused', prerequisitesComplete: true }, new AbortController().signal, options);
  return content.flatMap(item => item.type === 'text' ? [item.text] : []).join('');
}

test('file tools and bash reach the machine /tmp by absolute path, beside the checkout', async () => {
  const checkout = await scratch('gitspace-checkout-');
  const work = await scratch('gitspace-agent-scratch-');
  const notes = join(work, 'nested', 'notes.txt');
  await run(checkout, 'write', { path: notes, content: 'frames: 12\n' });
  await run(checkout, 'edit', { path: notes, edits: [{ oldText: '12', newText: '24' }] });
  expect(await run(checkout, 'read', { path: notes })).toBe('frames: 24\n');
  expect(await readFile(notes, 'utf8')).toBe('frames: 24\n');
  expect(await run(checkout, 'bash', { command: 'pwd && cat nested/notes.txt', cwd: work })).toBe(`Exit code: 0\n${work}\nframes: 24\n`);
  // Relative paths are still the checkout's.
  await run(checkout, 'write', { path: 'tracked.txt', content: 'checkout\n' });
  expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('checkout\n');
});

test('no absolute path outside /tmp, and no /tmp symlink leading out of it, reaches a file tool', async () => {
  const checkout = await scratch('gitspace-checkout-');
  const work = await scratch('gitspace-agent-scratch-');
  const outside = await scratch('.gitspace-outside-tmp-', homedir());
  await symlink(outside, join(work, 'escape'));
  await expect(run(checkout, 'read', { path: join(homedir(), '.bashrc') })).rejects.toThrow('Absolute paths must be inside /tmp');
  await expect(run(checkout, 'write', { path: '/tmp/../etc/gitspace-escape', content: 'x' })).rejects.toThrow('Absolute paths must be inside /tmp');
  await expect(run(checkout, 'write', { path: join(work, 'escape', 'planted.txt'), content: 'x' })).rejects.toThrow('Symlink leaves authorized /tmp');
  await expect(run(checkout, 'write', { path: '../outside.txt', content: 'x' })).rejects.toThrow('Path leaves authorized checkout');
  await expect(run(checkout, 'bash', { command: 'pwd', cwd: outside })).rejects.toThrow('Absolute paths must be inside /tmp');
  await expect(readFile(join(outside, 'planted.txt'), 'utf8')).rejects.toThrow();
});
