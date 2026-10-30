import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gitspaceContract, terminalStreamResource } from '@gitspace/protocol/rpc-contract';
import { createBrowserClient, fetchTransport } from 'result-rpc/client';
import { closeDaemonClients, daemonClientForProject } from '@gitspace/supervisor';
import { WorkspaceHubTerminalCoordinator } from '../src/workspace-hub.js';
import { createGitSpaceRpcHandler } from '../src/rpc-router.js';

// Cloud authorities own repository, lifecycle, Inspector, and session regressions.
// This router only owns explicitly addressed machine tools.
test('refuses a launch addressed to another machine before running the builder', async () => {
  let builds = 0;
  const rpc = createGitSpaceRpcHandler({
    machineId: 'machine-a', terminals: new WorkspaceHubTerminalCoordinator('machine-a', { path: () => null, projectId: () => null, list: () => [], use: async () => {} }),
    deployment: { launch: () => { builds++; throw new Error('Build source unavailable'); } },
  });
  const client = createBrowserClient({ contract: gitspaceContract, transport: fetchTransport({
    url: 'https://machine.test/rpc', fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => rpc.handler(new Request(input, init)), { preconnect: fetch.preconnect }),
  }) });
  expect(await client.deployment.launch({ source: { kind: 'workspace', workspaceId: 'space' }, machineId: 'machine-b', targets: ['worker'] })).toMatchObject({ status: 'error', error: { data: { message: expect.stringContaining('machine-b') } } });
  expect(builds).toBe(0);
  expect(await client.deployment.launch({ source: { kind: 'workspace', workspaceId: 'space' }, machineId: 'machine-a', targets: ['worker'] })).toMatchObject({ status: 'error', error: { data: { message: 'Build source unavailable' } } });
  expect(builds).toBe(1);
  expect(await client.settings.get({})).toMatchObject({ status: 'error' });
  expect(builds).toBe(1);
});

test('runs a shell in an explicit ready cache without a held workspace and fences other machines', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-rpc-cache-'));
  const checkout = join(root, 'workspace');
  mkdirSync(checkout);
  let announced = Promise.withResolvers<void>();
  const terminals = new WorkspaceHubTerminalCoordinator('machine-a', {
    path: spaceId => spaceId === 'workspace-a' ? checkout : null,
    projectId: spaceId => spaceId === 'workspace-a' ? 'project-a' : null,
    list: () => ['workspace-a'],
    use: async () => {},
  }, undefined, () => {
    announced.resolve();
    announced = Promise.withResolvers<void>();
  });
  const rpc = createGitSpaceRpcHandler({ machineId: 'machine-a', terminals });
  const client = createBrowserClient({ contract: gitspaceContract, transport: fetchTransport({
    url: 'https://machine.test/rpc', fetch: Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => rpc.handler(new Request(input, init)), { preconnect: fetch.preconnect }),
  }) });
  try {
    expect(await client.terminals.create({ spaceId: 'workspace-a', machineId: 'machine-b' })).toMatchObject({ status: 'error' });
    const created = await client.terminals.create({ spaceId: 'workspace-a', machineId: 'machine-a' });
    if (created.status === 'error') throw created.error;
    expect(created.value).toMatchObject({ kind: 'user', cwd: checkout, machineId: 'machine-a' });
    const target = { spaceId: 'workspace-a', machineId: 'machine-a', name: created.value.name };
    expect(await client.terminals.send({ ...target, machineId: 'machine-b', data: 'exit\r' })).toMatchObject({ status: 'error' });
    expect(await client.terminals.send({ ...target, data: "printf '%s%s\\n' rpc- cache-output\r" })).toMatchObject({ status: 'ok' });
    // Each read returns the events after its cursor; a notice prompts the next read.
    const follow = async (after: number | null): Promise<void> => {
      const noticed = announced.promise;
      const read = await client.terminals.events({ ...target, after });
      if (read.status === 'error') throw read.error;
      if (read.value.some((event) => event.type !== 'resync' && event.value.output?.data.includes('rpc-cache-output'))) return;
      await noticed;
      return follow(read.value.at(-1)?.cursor ?? after);
    };
    await follow(null);
    terminals.unwatched(terminalStreamResource('workspace-a', 'machine-a', target.name), Number.MAX_SAFE_INTEGER);
    const output = await client.terminals.read({ ...target, cursor: null });
    expect(output).toMatchObject({ status: 'ok', value: { data: expect.stringContaining('rpc-cache-output') } });
    expect(await client.terminals.stop({ ...target, machineId: 'machine-b' })).toMatchObject({ status: 'error' });
    expect(await client.terminals.stop(target)).toMatchObject({ status: 'ok' });
    await expect(terminals.runLifecyclePlan('workspace-a', 'workspace/materialize', [], {}, {
      directory: join(root, 'detached-recovery'), interactive: true,
    })).rejects.toThrow('detached recovery checkout');

    const started = Promise.withResolvers<void>();
    const execution = terminals.runLifecyclePlan('workspace-a', 'workspace/materialize', [{
      id: 'authenticate', kind: 'script', command: '/approved/authenticate.sh', content: "printf 'private-auth-prompt'; IFS= read -r answer",
    }], { PATH: process.env.PATH ?? '' }, { directory: checkout, interactive: true, runId: 'protected-rpc', onStarted: async () => started.resolve() });
    await Promise.race([started.promise, execution.then(() => { throw new Error('Lifecycle exited before terminal attachment'); })]);
    const protectedTarget = { ...target, name: 'life-protected-rpc' };
    try {
      // Only a browser session reads protected output; the machine never attaches for anyone else.
      expect(await client.terminals.live({ ...protectedTarget, after: null })).toMatchObject({ status: 'error' });
      expect(await client.terminals.send({ ...protectedTarget, data: 'unauthorized\\n' })).toMatchObject({ status: 'error' });
      expect(await client.terminals.stop(protectedTarget)).toMatchObject({ status: 'error' });
      const metadata = await client.terminals.read({ ...protectedTarget, cursor: null });
      expect(metadata).toMatchObject({ status: 'ok' });
      if (metadata.status === 'error') throw metadata.error;
      expect(metadata.value.data).not.toContain('private-auth-prompt');
    } finally {
      await terminals.cancelLifecycleRun('workspace-a', protectedTarget.name, checkout);
      await execution;
    }
  } finally {
    const daemon = await daemonClientForProject(checkout);
    await daemon.request({ op: 'shutdown' });
    await closeDaemonClients();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
