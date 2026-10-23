import { test, expect, jest } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { signServiceAssertion, SERVICE_ASSERTION_HEADER } from '@gitspace/protocol/service-access';
import { WorkspaceServiceManager } from '../src/workspace-services.js';
import { machineProcessOperation } from '../src/runtime-operations.js';
import { cacheServiceOperation } from '../src/cache-services.js';
import type { WorkspaceCheckouts } from '../src/workspace-hub.js';
import { HostedRoutesFake } from './hosted-routes-fake.js';

const noCheckouts: WorkspaceCheckouts = { path: () => null, projectId: () => null, list: () => [], use: async () => {}, changed: async () => {} };

test('proc ready.port becomes a private signed machine URL and stop releases its lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proc-service-'));
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const trust = { accountId: 'account', publicKey: credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))) };
  const registry = new HostedRoutesFake([{ id: 'machine', label: 'alpha' }]);
  const leases = registry.leases;
  const manager = new WorkspaceServiceManager(noCheckouts, { list: async () => [], startService: async () => { throw new Error('Workspace terminal not allowed'); }, stop: async () => { throw new Error('Workspace terminal not allowed'); } }, 'machine', root, 'gssh.dev', 'test', registry.authority('machine'), async () => trust);
  const [allocated] = await manager.allocateDefinitionPorts('workspace', { name: 'proc-http', command: process.execPath, args: [], cwd: '.', env: {}, ports: [{ name: 'http', protocol: 'http' }], ingress: [] });
  if (!allocated) throw new Error('Missing allocated port');
  const attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'cache', generation: 1, checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: ['proc'], updatedAt: new Date().toISOString() });
  const local = { attachment, rootPath: root, executionSecret: 'secret', prerequisitesComplete: true };
  const handler = machineProcessOperation({ services: manager, reportProcessExit: async () => {} });
  const base = { version: 1, projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'cache', generation: 1, conversationId: 'conversation', conversationKind: 'main', taskId: 'task', requestId: 'request', attemptId: 'attempt', tool: 'proc', deadlineAt: new Date(Date.now() + 30_000).toISOString(), replay: 'unsafe' };
  const signal = AbortSignal.timeout(30_000);
  const machinePart = `alpha-${new Bun.CryptoHasher('sha256').update('machine').digest('hex').slice(0, 4)}`;
  const hostname = `proc-http--${machinePart}--workspace--test-srv.gssh.dev`;
  try {
    await handler(RuntimeToolDispatchSchema.parse({ ...base, args: { op: 'start', spec: { name: 'proc-http', application: process.execPath, args: ['-e', `console.log('proc service output');Bun.serve({hostname:'127.0.0.1',port:${allocated.port},fetch:()=>new Response('proc-private')})`], cwd: '.', env: {}, pty: false, restart: 'no', persist: true, detached: false, ready: { port: allocated.port, host: '127.0.0.1', timeoutMs: 10_000 } } } }), local, signal);
    expect(leases.get(hostname)).toMatchObject({ machineId: 'machine', workspaceId: 'workspace', source: 'process' });
    expect([...leases.keys()]).toEqual([hostname]);
    expect(await (await fetch(`http://127.0.0.1:${allocated.port}/`)).text()).toBe('proc-private');
    expect((await manager.proxy(new Request(`https://${hostname}/`)))?.status).toBe(401);
    const inventory = await cacheServiceOperation(manager, local, { op: 'list' });
    expect(inventory).toMatchObject([{ name: 'proc-http', source: 'process', state: 'ready', url: null, machineUrl: `https://${hostname}` }]);
    const output = await cacheServiceOperation(manager, local, { op: 'logs', name: 'proc-http', source: 'process' });
    expect(output).toMatchObject({ name: 'proc-http', text: expect.stringContaining('proc service output') });
    const assertion = await signServiceAssertion({ version: 1, accountId: 'account', hostname, machineId: 'machine', caller: { kind: 'cloud', accountId: 'account', projectId: 'project', workspaceId: 'workspace' }, method: 'GET', target: '/', issuedAt: Date.now(), expiresAt: Date.now() + 30_000, nonce: crypto.randomUUID() }, keys.privateKey);
    expect(await (await manager.proxy(new Request(`https://${hostname}/`, { headers: { [SERVICE_ASSERTION_HEADER]: assertion } })))?.text()).toBe('proc-private');
    await handler(RuntimeToolDispatchSchema.parse({ ...base, args: { op: 'stop', name: 'proc-http' } }), local, signal);
    expect(leases.has(hostname)).toBe(false);
    expect(await manager.proxy(new Request(`https://${hostname}/`))).toBeNull();
    await cacheServiceOperation(manager, local, { op: 'start', name: 'proc-http', source: 'process' });
    expect(leases.has(hostname)).toBe(true);
  } finally {
    await handler(RuntimeToolDispatchSchema.parse({ ...base, args: { op: 'stop', name: 'proc-http' } }), local, AbortSignal.timeout(5000)).catch(() => {});
    await manager.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test('a workspace process that exits on its own is reported to the account with its workspace and run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proc-exit-'));
  const manager = new WorkspaceServiceManager(noCheckouts, { list: async () => [], startService: async () => { throw new Error('unused'); }, stop: async () => { throw new Error('unused'); } }, 'machine', root, 'gssh.dev', 'test', new HostedRoutesFake([{ id: 'machine', label: 'alpha' }]).authority('machine'));
  const reported = Promise.withResolvers<Parameters<Parameters<typeof machineProcessOperation>[0]['reportProcessExit']>[0]>();
  const handler = machineProcessOperation({ services: manager, reportProcessExit: async input => { reported.resolve(input); } });
  const attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'cache', generation: 1, checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: ['proc'], updatedAt: new Date().toISOString() });
  const local = { attachment, rootPath: root, executionSecret: 'secret', prerequisitesComplete: true };
  const dispatch = { version: 1, projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'cache', generation: 1, conversationId: 'conversation', conversationKind: 'main', taskId: 'task', requestId: 'request', attemptId: 'attempt', tool: 'proc', deadlineAt: new Date(Date.now() + 30_000).toISOString(), replay: 'unsafe' };
  try {
    const [started] = await handler(RuntimeToolDispatchSchema.parse({ ...dispatch, args: { op: 'start', spec: { name: 'short-job', application: process.execPath, args: ['-e', 'process.exit(3)'], cwd: '.', env: {}, pty: false, restart: 'no', persist: true, detached: false } } }), local, AbortSignal.timeout(20_000));
    const daemon = started?.type === 'text' ? JSON.parse(started.text).daemon : null;
    const report = await reported.promise;
    expect(report).toMatchObject({ projectId: 'project', workspaceId: 'workspace', daemon: { id: daemon.id, name: 'short-job', restartCount: 0, state: expect.stringMatching(/^(exited|failed)$/u) } });
  } finally {
    await manager.dispose(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test('a failed route renewal is retried on the next tick instead of ending the machine', async () => {
  const root = await mkdtemp(join(tmpdir(), 'route-lease-'));
  const renewals: string[] = [];
  const registry = new HostedRoutesFake([{ id: 'machine', label: 'alpha' }]);
  const manager = new WorkspaceServiceManager(noCheckouts, { list: async () => [], startService: async () => { throw new Error('unused'); }, stop: async () => { throw new Error('unused'); } }, 'machine', root, 'gssh.dev', 'test', {
    ...registry.authority('machine'),
    leaseHostedRoute: async (projectId, route) => {
      renewals.push(route.hostname);
      if (renewals.length === 2) throw new Error('Connection closed: this Durable Object instance is no longer active.');
      return registry.authority('machine').leaseHostedRoute(projectId, route);
    },
  });
  jest.useFakeTimers();
  try {
    await manager.registerService({ projectId: 'project', workspaceId: 'workspace', generation: 1, source: 'process', name: 'storybook', ports: [{ name: 'http', port: 6421 }] });
    await manager.rehydrate();
    for (const _tick of [1, 2]) {
      jest.advanceTimersByTime(60_000);
      for (let flush = 0; flush < 5; flush += 1) await Promise.resolve();
    }
    expect(renewals).toEqual(Array(3).fill(`storybook--alpha-${new Bun.CryptoHasher('sha256').update('machine').digest('hex').slice(0, 4)}--workspace--test-srv.gssh.dev`));
  } finally {
    jest.useRealTimers();
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
