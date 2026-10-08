import { afterEach, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { checkoutTerminalEnvironment, executeMachineTool, type MachineToolOptions } from './tools.js';

const roots: string[] = [];
const unused = async (): Promise<never> => { throw new Error('Unexpected artifact access'); };
// Like the supervisor launch (inheritEnv: false), the child sees exactly the environment the tool supplies.
const options: MachineToolOptions = { runCommand: command => {
  const { promise, resolve } = Promise.withResolvers<{ exitCode: number; output: string }>();
  execFile(command.application, command.args, { cwd: command.cwd, env: command.env ?? {} }, (error, stdout, stderr) => {
    resolve({ exitCode: typeof error?.code === 'number' ? error.code : 0, output: stdout + stderr });
  });
  return promise;
}, artifacts: () => ({ read: unused, write: unused }) };

async function checkout(bundle: string | null) {
  const rootPath = await mkdtemp(join(tmpdir(), 'runtime-bundle-terminal-'));
  roots.push(rootPath);
  await mkdir(join(rootPath, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(rootPath, 'node_modules', '.bin', 'bundle-tool'), '#!/bin/sh\necho bundle-tool ran\n', { mode: 0o755 });
  if (bundle !== null) {
    await mkdir(join(rootPath, '.gitspace'));
    await writeFile(join(rootPath, '.gitspace', 'bundle.json'), bundle);
  }
  return rootPath;
}

async function bash(rootPath: string, command: string) {
  const attachment = RuntimeAttachmentSchema.parse({ attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: ['bash'], updatedAt: new Date().toISOString() });
  const dispatch = RuntimeToolDispatchSchema.parse({ conversationKind: 'main', version: 1, conversationId: 'conversation', taskId: 'task', attachmentId: 'attachment', projectId: 'project', workspaceId: 'workspace', machineId: 'machine', generation: 1, requestId: 'request', attemptId: 'attempt', tool: 'bash', args: { command }, deadlineAt: new Date(Date.now() + 60_000).toISOString(), replay: 'unsafe' });
  const content = await executeMachineTool(dispatch, { attachment, rootPath, executionSecret: 'unused', prerequisitesComplete: true }, new AbortController().signal, options);
  return content.flatMap(item => item.type === 'text' ? [item.text] : []).join('');
}

const bundle = (terminal: unknown) => JSON.stringify({ version: 1, profiles: { base: {} }, terminal });

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test('bash resolves checkout tools listed in bundle terminal.path and receives terminal.env', async () => {
  const output = await bash(await checkout(bundle({ path: ['node_modules/.bin'], env: { BUNDLE_MODE: 'dev' } })), 'bundle-tool && echo "mode=$BUNDLE_MODE" && command -v ls');
  expect(output).toStartWith('Exit code: 0\n');
  expect(output).toContain('bundle-tool ran');
  expect(output).toContain('mode=dev');
});

test('bash does not see checkout tools without a terminal section, and an invalid bundle adds nothing', async () => {
  for (const source of [null, bundle(undefined), bundle({ path: ['/abs'] }), '{not json']) {
    const output = await bash(await checkout(source), 'bundle-tool; echo after');
    expect(output).toStartWith('Exit code: 0\n');
    expect(output).toContain('bundle-tool: command not found');
    expect(output).toContain('after');
  }
});

test('terminal.path keeps only existing directories whose real path stays inside the checkout or home', async () => {
  const root = await realpath(await checkout(bundle({ path: ['bin', 'node_modules/.bin', 'missing', 'inner', '~/tools', '~/linked'] })));
  const outside = await realpath(await mkdtemp(join(tmpdir(), 'runtime-bundle-outside-')));
  const home = await realpath(await mkdtemp(join(tmpdir(), 'runtime-bundle-home-')));
  roots.push(outside, home);
  await writeFile(join(outside, 'escape-tool'), '#!/bin/sh\necho escaped\n', { mode: 0o755 });
  await symlink(outside, join(root, 'bin'));
  await symlink(join(root, 'node_modules'), join(root, 'inner'));
  await mkdir(join(home, 'tools'));
  await symlink(outside, join(home, 'linked'));
  const environment = await checkoutTerminalEnvironment(root, { PATH: '/usr/bin:/bin', HOME: home });
  expect(environment.PATH).toBe(`${root}/node_modules/.bin:${root}/inner:${home}/tools:/usr/bin:/bin`);
  const output = await bash(root, 'escape-tool; bundle-tool');
  expect(output).toContain('escape-tool: command not found');
  expect(output).toContain('bundle-tool ran');
});
