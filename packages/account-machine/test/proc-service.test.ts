import { test, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitSpaceDatabase } from '@gitspace/core';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { signServiceAssertion, SERVICE_ASSERTION_HEADER } from '@gitspace/protocol/service-access';
import { WorkspaceServiceManager } from '../src/workspace-services.js';
import { machineProcessOperation } from '../src/runtime-operations.js';

test('proc ready.port becomes a private signed route and stop releases its lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proc-service-'));
  const database = new GitSpaceDatabase(join(root, 'db.sqlite'));
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const trust = { accountId: 'account', publicKey: credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))) };
  const leases = new Map<string, string>();
  const manager = new WorkspaceServiceManager(database, { list: async () => [], startService: async () => { throw new Error('Primary not allowed'); }, stop: async () => { throw new Error('Primary not allowed'); } }, 'machine', root, 'gssh.dev', 'test', { leaseHostedRoute: async (projectId, route) => { leases.set(route.hostname, `${projectId}:${route.machineId}:${route.workspaceId}`); return { ...route, updatedAt: new Date().toISOString() }; }, releaseHostedRoute: async (_project, hostname) => leases.delete(hostname) }, async () => trust);
  const [allocated] = await manager.allocateDefinitionPorts('workspace', { name: 'proc-http', command: process.execPath, args: [], cwd: '.', env: {}, ports: [{ name: 'http', protocol: 'http' }] });
  if (!allocated) throw new Error('Missing allocated port');
  const attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'replica', generation: 1, role: 'replica', checkout: { kind: 'snapshot', commit: 'a'.repeat(40) }, state: 'ready', capabilities: ['proc'], updatedAt: new Date().toISOString() });
  const local = { attachment, rootPath: root, executionSecret: 'secret', prerequisitesComplete: true };
  const handler = machineProcessOperation({ services: manager });
  const base = { version: 1, projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'replica', generation: 1, conversationId: 'conversation', conversationKind: 'main', taskId: 'task', requestId: 'request', attemptId: 'attempt', tool: 'proc', deadlineAt: new Date(Date.now() + 30_000).toISOString(), replay: 'unsafe' };
  const signal = AbortSignal.timeout(30_000);
  const hostname = 'proc-http--workspace--test-srv.gssh.dev';
  try {
    await handler(RuntimeToolDispatchSchema.parse({ ...base, args: { op: 'start', spec: { name: 'proc-http', application: process.execPath, args: ['-e', `Bun.serve({hostname:'127.0.0.1',port:${allocated.port},fetch:()=>new Response('proc-private')})`], cwd: '.', env: {}, pty: false, restart: 'no', persist: true, detached: false, ready: { port: allocated.port, host: '127.0.0.1', timeoutMs: 10_000 } } } }), local, signal);
    expect(leases.get(hostname)).toBe('project:machine:workspace');
    expect(await (await fetch(`http://127.0.0.1:${allocated.port}/`)).text()).toBe('proc-private');
    expect((await manager.proxy(new Request(`https://${hostname}/`)))?.status).toBe(401);
    const assertion = await signServiceAssertion({ version: 1, accountId: 'account', hostname, machineId: 'machine', caller: { kind: 'cloud', accountId: 'account', projectId: 'project', workspaceId: 'workspace' }, method: 'GET', target: '/', issuedAt: Date.now(), expiresAt: Date.now() + 30_000, nonce: crypto.randomUUID() }, keys.privateKey);
    expect(await (await manager.proxy(new Request(`https://${hostname}/`, { headers: { [SERVICE_ASSERTION_HEADER]: assertion } })))?.text()).toBe('proc-private');
    await handler(RuntimeToolDispatchSchema.parse({ ...base, args: { op: 'stop', name: 'proc-http' } }), local, signal);
    expect(leases.has(hostname)).toBe(false);
    expect(await manager.proxy(new Request(`https://${hostname}/`))).toBeNull();
  } finally {
    await handler(RuntimeToolDispatchSchema.parse({ ...base, args: { op: 'stop', name: 'proc-http' } }), local, AbortSignal.timeout(5000)).catch(() => {});
    await manager.dispose(); database.close(); await rm(root, { recursive: true, force: true });
  }
}, 30_000);
