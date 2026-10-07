import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSpaceDatabase } from '@gitspace/core';
import { RuntimeAttachmentSchema } from '@gitspace/protocol-runtime';
import { RuntimeServiceSchema } from '@gitspace/protocol-runtime/services';
import { replicaServiceOperation } from '../src/replica-services.js';
import { WorkspaceServiceManager } from '../src/workspace-services.js';

test('ready replica reads its attachment checkout and registers proc ports privately without primary possession', async () => {
  const root = await mkdtemp(join(tmpdir(), 'replica-service-'));
  const database = new GitSpaceDatabase(join(root, 'state.db'));
  try {
    await mkdir(join(root, 'checkout/.gitspace'), { recursive: true });
    await writeFile(join(root, 'checkout/.gitspace/services.json'), JSON.stringify({ services: [{ name: 'web', command: process.execPath, args: ['-e', 'Bun.serve({hostname:\"127.0.0.1\",port:Number(process.env.PORT),fetch:()=>new Response(\"replica service\")})'], ports: [{ name: 'http' }] }] }));
    const routes: string[] = [];
    const manager = new WorkspaceServiceManager(database, { list: async () => [], startService: async () => { throw new Error('Legacy primary terminal is not allowed'); }, stop: async () => { throw new Error('Legacy primary terminal is not allowed'); } }, 'machine-b', root, 'gssh.dev', 'test', { leaseHostedRoute: async (_project, route) => { routes.push(route.hostname); return { ...route, updatedAt: new Date().toISOString() }; }, releaseHostedRoute: async () => true });
    const attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'cache', machineId: 'machine-b', generation: 1, ownershipGeneration: 1, role: 'cache', checkout: { kind: 'snapshot', commit: 'a'.repeat(40) }, state: 'ready', capabilities: ['read', 'service'], updatedAt: new Date().toISOString() });
    const local = { attachment, rootPath: join(root, 'checkout'), executionSecret: 'secret', prerequisitesComplete: true };
    const definitions = manager.parseDefinitions(JSON.parse(await Bun.file(join(local.rootPath, '.gitspace/services.json')).text()));
    expect(definitions[0]?.name).toBe('web');
    const started = RuntimeServiceSchema.parse(await replicaServiceOperation(manager, local, { op: 'start', name: 'web' }));
    expect(started).toMatchObject({ name: 'web', state: 'ready', url: 'https://web--workspace-machine-b--test-srv.gssh.dev' });
    const listed = RuntimeServiceSchema.array().parse(await replicaServiceOperation(manager, local, { op: 'list' }));
    expect(listed).toEqual([started]);
    await replicaServiceOperation(manager, local, { op: 'stop', name: 'web' });
    const url = await manager.registerProcessRoute({ projectId: attachment.projectId, workspaceId: attachment.workspaceId, generation: attachment.generation, name: 'proc-http', portName: 'http', port: 3000 });
    expect(url).toBe('https://proc-http--workspace-machine-b--test-srv.gssh.dev');
    expect(routes).toEqual(['web--workspace-machine-b--test-srv.gssh.dev', 'proc-http--workspace-machine-b--test-srv.gssh.dev']);
    expect((await manager.proxy(new Request(url)))?.status).toBe(401);
    await expect(replicaServiceOperation(manager, { ...local, attachment: { ...attachment, state: 'draining' } }, { op: 'list' })).rejects.toThrow('ready attachment');
    await manager.dispose();
  } finally { database.close(); await rm(root, { recursive: true, force: true }); }
});
