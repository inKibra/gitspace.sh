import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSpaceDatabase } from '@gitspace/core';
import { RuntimeAttachmentSchema } from '@gitspace/protocol-runtime';
import { RuntimeServiceSchema } from '@gitspace/protocol-runtime/services';
import { cacheServiceOperation } from '../src/cache-services.js';
import { WorkspaceServiceManager } from '../src/workspace-services.js';

test('ready cache reads its attachment checkout and registers proc ports privately without workspace possession', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cache-service-'));
  const database = new GitSpaceDatabase(join(root, 'state.db'));
  try {
    await mkdir(join(root, 'checkout/.gitspace'), { recursive: true });
    await writeFile(join(root, 'checkout/.gitspace/services.json'), JSON.stringify({ services: [{ name: 'web', command: process.execPath, args: ['-e', 'Bun.serve({hostname:\"127.0.0.1\",port:Number(process.env.PORT),fetch:()=>new Response(\"cache service\")})'], ports: [{ name: 'http' }] }] }));
    const routes: string[] = [];
    const manager = new WorkspaceServiceManager(database, { list: async () => [], startService: async () => { throw new Error('Workspace terminal is not allowed'); }, stop: async () => { throw new Error('Workspace terminal is not allowed'); } }, 'machine-b', root, 'gssh.dev', 'test', { leaseHostedRoute: async (_project, route) => { routes.push(route.hostname); return { ...route, updatedAt: new Date().toISOString() }; }, releaseHostedRoute: async () => true });
    const attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'cache', machineId: 'machine-b', generation: 1, ownershipGeneration: 1, role: 'cache', checkout: { kind: 'snapshot', commit: 'a'.repeat(40) }, state: 'ready', capabilities: ['read', 'service'], updatedAt: new Date().toISOString() });
    const local = { attachment, rootPath: join(root, 'checkout'), executionSecret: 'secret', prerequisitesComplete: true };
    const definitions = manager.parseDefinitions(JSON.parse(await Bun.file(join(local.rootPath, '.gitspace/services.json')).text()));
    expect(definitions[0]?.name).toBe('web');
    const started = RuntimeServiceSchema.parse(await cacheServiceOperation(manager, local, { op: 'start', name: 'web' }));
    expect(started).toMatchObject({ name: 'web', state: 'ready', url: 'https://web--workspace-machine-b--test-srv.gssh.dev' });
    const listed = RuntimeServiceSchema.array().parse(await cacheServiceOperation(manager, local, { op: 'list' }));
    expect(listed).toEqual([started]);
    await cacheServiceOperation(manager, local, { op: 'stop', name: 'web' });
    const url = await manager.registerProcessRoute({ projectId: attachment.projectId, workspaceId: attachment.workspaceId, generation: attachment.generation, name: 'proc-http', portName: 'http', port: 3000 });
    expect(url).toBe('https://proc-http--workspace-machine-b--test-srv.gssh.dev');
    expect(routes).toEqual(['web--workspace-machine-b--test-srv.gssh.dev', 'proc-http--workspace-machine-b--test-srv.gssh.dev']);
    expect((await manager.proxy(new Request(url)))?.status).toBe(401);
    await expect(cacheServiceOperation(manager, { ...local, attachment: { ...attachment, state: 'draining' } }, { op: 'list' })).rejects.toThrow('ready attachment');
    await manager.dispose();
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});

test('declared services resolve their command through bundle terminal.path and receive terminal.env', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cache-service-bundle-'));
  const database = new GitSpaceDatabase(join(root, 'state.db'));
  const manager = new WorkspaceServiceManager(database, { list: async () => [], startService: async () => { throw new Error('Workspace terminal is not allowed'); }, stop: async () => { throw new Error('Workspace terminal is not allowed'); } }, 'machine-b', root, 'gssh.dev', 'test', { leaseHostedRoute: async (_project, route) => ({ ...route, updatedAt: new Date().toISOString() }), releaseHostedRoute: async () => true });
  try {
    const checkout = join(root, 'checkout');
    await mkdir(join(checkout, '.gitspace'), { recursive: true });
    await mkdir(join(checkout, 'node_modules/.bin'), { recursive: true });
    await writeFile(join(checkout, 'node_modules/.bin/bundle-web'), `#!/bin/sh\necho "mode=$BUNDLE_MODE"\nexec '${process.execPath}' -e 'Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT),fetch:()=>new Response("ok")})'\n`, { mode: 0o755 });
    await writeFile(join(checkout, '.gitspace/services.json'), JSON.stringify({ services: [{ name: 'web', command: 'bundle-web', ports: [{ name: 'http' }] }] }));
    await writeFile(join(checkout, '.gitspace/bundle.json'), JSON.stringify({ version: 1, profiles: { base: {} }, terminal: { path: ['node_modules/.bin'], env: { BUNDLE_MODE: 'preview' } } }));
    const attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'cache-bundle', machineId: 'machine-b', generation: 1, ownershipGeneration: 1, role: 'cache', checkout: { kind: 'snapshot', commit: 'a'.repeat(40) }, state: 'ready', capabilities: ['read', 'service'], updatedAt: new Date().toISOString() });
    const local = { attachment, rootPath: checkout, executionSecret: 'secret', prerequisitesComplete: true };
    expect(RuntimeServiceSchema.parse(await cacheServiceOperation(manager, local, { op: 'start', name: 'web' })).state).toBe('ready');
    expect(await cacheServiceOperation(manager, local, { op: 'logs', name: 'web', source: 'declared' })).toMatchObject({ text: expect.stringContaining('mode=preview') });
    await cacheServiceOperation(manager, local, { op: 'stop', name: 'web', source: 'declared' });
  } finally { await manager.dispose(); database.close(); await rm(root, { recursive: true, force: true }); }
});
