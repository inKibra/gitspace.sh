import { test, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import { RuntimeServiceSchema } from '@gitspace/protocol-runtime/services';
import { SERVICE_ASSERTION_HEADER, signServiceAssertion } from '@gitspace/protocol/service-access';
import { cacheServiceOperation, rehydrateServiceRoutes } from '../src/cache-services.js';
import { machineProcessOperation } from '../src/runtime-operations.js';
import { serviceHostname, WorkspaceServiceManager } from '../src/workspace-services.js';
import type { WorkspaceCheckouts } from '../src/workspace-hub.js';
import { HostedRoutesFake } from './hosted-routes-fake.js';

const noCheckouts: WorkspaceCheckouts = { path: () => null, projectId: () => null, list: () => [], use: async () => {}, changed: async () => {} };
const terminals = { list: async () => [], startService: async () => { throw new Error('unused'); }, stop: async () => { throw new Error('unused'); } };
const ALPHA = 'aaaa1111-0000-4000-8000-000000000001';
const BETA = 'bbbb2222-0000-4000-8000-000000000002';
const WEB = 'web--workspace--test-srv.gssh.dev';
const WEB_ADMIN = 'web-admin--workspace--test-srv.gssh.dev';

async function trustKeys() {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const trust = { accountId: 'account', publicKey: credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))) };
  const fetchVia = async (manager: WorkspaceServiceManager, machineId: string, hostname: string) => {
    const assertion = await signServiceAssertion({ version: 1, accountId: 'account', hostname, machineId, caller: { kind: 'device', accountId: 'account', deviceId: 'browser' }, method: 'GET', target: '/', issuedAt: Date.now(), expiresAt: Date.now() + 30_000, nonce: crypto.randomUUID() }, keys.privateKey);
    const response = await manager.proxy(new Request(`https://${hostname}/`, { headers: { [SERVICE_ASSERTION_HEADER]: assertion } }));
    return response ? response.text() : null;
  };
  return { trust, fetchVia };
}

/** One machine's checkout of the workspace, with a declared `web` answering on two http ports. */
async function machine(root: string, registry: HostedRoutesFake, machineId: string, who: string, trust: { accountId: string; publicKey: string }) {
  const checkout = join(root, who);
  await mkdir(join(checkout, '.gitspace'), { recursive: true });
  const script = `for (const port of ['HTTP','ADMIN']) Bun.serve({hostname:'127.0.0.1',port:Number(process.env['GITSPACE_PORT_'+port]),fetch:()=>new Response(port.toLowerCase()+' '+process.env.WHO)})`;
  await writeFile(join(checkout, '.gitspace/services.json'), JSON.stringify({ services: [{ name: 'web', command: process.execPath, args: ['-e', script], env: { WHO: who }, ports: [{ name: 'http' }, { name: 'admin' }, { name: 'db', protocol: 'tcp' }] }] }));
  const manager = new WorkspaceServiceManager(noCheckouts, terminals, machineId, join(root, `${who}-runtime`), 'gssh.dev', 'test', registry.authority(machineId), async () => trust);
  const attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: `cache-${who}`, machineId, generation: 1, checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: ['read', 'service', 'proc'], updatedAt: new Date().toISOString() });
  return { manager, local: { attachment, rootPath: checkout, executionSecret: 'secret', prerequisitesComplete: true } };
}

function dispatch(machineId: string, args: Record<string, unknown>) {
  return RuntimeToolDispatchSchema.parse({ version: 1, projectId: 'project', workspaceId: 'workspace', machineId, attachmentId: 'cache', generation: 1, conversationId: 'conversation', conversationKind: 'main', taskId: 'task', requestId: 'request', attemptId: crypto.randomUUID(), tool: 'proc', deadlineAt: new Date(Date.now() + 30_000).toISOString(), replay: 'unsafe', args });
}

test('workspace URLs have no machine part, machine URLs carry the readable machine, and each part keeps its share of one DNS label', () => {
  expect(serviceHostname('gssh.dev', 'test', 'workspace', 'web', null)).toBe('web--workspace--test-srv.gssh.dev');
  expect(serviceHostname('gssh.dev', 'test', 'workspace', 'web', 'alpha-aaaa')).toBe('web--alpha-aaaa--workspace--test-srv.gssh.dev');
  const [one, two] = ['one', 'two'].map(suffix => serviceHostname('gssh.dev', 'bradleat', `typia-narrow-${'x'.repeat(40)}-${suffix}`, 'storybook-preview-server', 'darktop-workstation-aaaa'));
  expect(one).not.toBe(two);
  for (const hostname of [one, two]) {
    expect(hostname?.split('.')[0]?.length).toBeLessThanOrEqual(63);
    expect(hostname?.split('.')[0]?.split('--')).toHaveLength(4);
    expect(hostname).toStartWith('storyb-');
  }
  expect(() => serviceHostname('gssh.dev', 'a'.repeat(26), 'workspace', 'web', null)).toThrow('GitSpace handle is too long to host workspace services');
  expect(serviceHostname('gssh.dev', 'a'.repeat(17), 'workspace', 'web', null)).toBe(`web--workspace--${'a'.repeat(17)}-srv.gssh.dev`);
  expect(() => serviceHostname('gssh.dev', 'a'.repeat(17), 'workspace', 'web', 'alpha-aaaa')).toThrow('GitSpace handle is too long to host workspace services');
});

test('the workspace URL stays on the first machine to start a declared service until a pin moves it, each http port has its own URLs, and a restart re-leases the pin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'service-urls-'));
  const registry = new HostedRoutesFake([{ id: ALPHA, label: 'alpha' }, { id: BETA, label: 'beta' }]);
  const { trust, fetchVia } = await trustKeys();
  const alpha = await machine(root, registry, ALPHA, 'alpha', trust);
  const beta = await machine(root, registry, BETA, 'beta', trust);
  let restarted: WorkspaceServiceManager | null = null;
  try {
    const first = RuntimeServiceSchema.parse(await cacheServiceOperation(alpha.manager, alpha.local, { op: 'start', name: 'web' }));
    expect(first).toMatchObject({
      url: `https://${WEB}`, machineUrl: 'https://web--alpha-aaaa--workspace--test-srv.gssh.dev',
      ports: [
        { name: 'http', url: `https://${WEB}`, machineUrl: 'https://web--alpha-aaaa--workspace--test-srv.gssh.dev', servedBy: null },
        { name: 'admin', url: `https://${WEB_ADMIN}`, machineUrl: 'https://web-admin--alpha-aaaa--workspace--test-srv.gssh.dev', servedBy: null },
      ],
    });
    expect(await fetchVia(alpha.manager, ALPHA, WEB)).toBe('http alpha');
    expect(await fetchVia(alpha.manager, ALPHA, WEB_ADMIN)).toBe('admin alpha');
    expect(await fetchVia(alpha.manager, ALPHA, 'web-admin--alpha-aaaa--workspace--test-srv.gssh.dev')).toBe('admin alpha');

    const second = RuntimeServiceSchema.parse(await cacheServiceOperation(beta.manager, beta.local, { op: 'start', name: 'web' }));
    expect(second).toMatchObject({ url: null, machineUrl: 'https://web--beta-bbbb--workspace--test-srv.gssh.dev', ports: [{ name: 'http', url: null, servedBy: 'alpha' }, { name: 'admin', url: null, servedBy: 'alpha' }] });
    expect(registry.leases.get(WEB)?.machineId).toBe(ALPHA);
    expect(await fetchVia(beta.manager, BETA, WEB)).toBeNull();
    expect(await fetchVia(beta.manager, BETA, 'web--beta-bbbb--workspace--test-srv.gssh.dev')).toBe('http beta');

    const [pinned] = await machineProcessOperation({ services: beta.manager, reportProcessExit: async () => {} })(dispatch(BETA, { op: 'pin', name: 'web', source: 'declared' }), beta.local, AbortSignal.timeout(20_000));
    expect(pinned?.type === 'text' ? JSON.parse(pinned.text) : null).toMatchObject({ op: 'pin', url: `https://${WEB}` });
    expect(registry.pointers.get(WEB)).toMatchObject({ machineId: BETA, machineLabel: 'beta', serviceName: 'web', source: 'declared', portName: 'http', setBy: 'pin' });
    expect(registry.pointers.get(WEB_ADMIN)?.machineId).toBe(ALPHA);
    expect(await fetchVia(beta.manager, BETA, WEB)).toBe('http beta');

    // Alpha's next lease of the moved URL is refused, and it stops routing it; its other URLs stay.
    await rehydrateServiceRoutes(alpha.manager, alpha.local);
    expect(await fetchVia(alpha.manager, ALPHA, WEB)).toBeNull();
    expect(await fetchVia(alpha.manager, ALPHA, WEB_ADMIN)).toBe('admin alpha');
    expect(RuntimeServiceSchema.array().parse(await cacheServiceOperation(alpha.manager, alpha.local, { op: 'list' }))[0]?.ports).toMatchObject([{ name: 'http', url: null, servedBy: 'beta' }, { name: 'admin', url: `https://${WEB_ADMIN}`, servedBy: null }]);

    // Beta restarts: the old lease lapses, and its rehydrate leases the pinned workspace URL again.
    registry.leases.delete(WEB);
    restarted = new WorkspaceServiceManager(noCheckouts, terminals, BETA, join(root, 'beta-runtime'), 'gssh.dev', 'test', registry.authority(BETA), async () => trust);
    expect(await fetchVia(restarted, BETA, WEB)).toBeNull();
    await rehydrateServiceRoutes(restarted, beta.local);
    expect(registry.leases.get(WEB)?.machineId).toBe(BETA);
    expect(await fetchVia(restarted, BETA, WEB)).toBe('http beta');
  } finally {
    await cacheServiceOperation(alpha.manager, alpha.local, { op: 'stop', name: 'web' }).catch(() => {});
    await cacheServiceOperation(beta.manager, beta.local, { op: 'stop', name: 'web' }).catch(() => {});
    await Promise.all([alpha.manager.dispose(), beta.manager.dispose(), restarted?.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test('an ad hoc process named like a declared service gets only its machine URL until it is pinned, and a restart re-leases its pin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'service-urls-process-'));
  const registry = new HostedRoutesFake([{ id: ALPHA, label: 'alpha' }]);
  const { trust, fetchVia } = await trustKeys();
  const alpha = await machine(root, registry, ALPHA, 'alpha', trust);
  const proc = machineProcessOperation({ services: alpha.manager, reportProcessExit: async () => {} });
  const [allocated] = await alpha.manager.allocateDefinitionPorts('workspace', { name: 'adhoc', command: process.execPath, args: [], cwd: '.', env: {}, ports: [{ name: 'http', protocol: 'http' }] });
  if (!allocated) throw new Error('Missing allocated port');
  let restarted: WorkspaceServiceManager | null = null;
  try {
    const [started] = await proc(dispatch(ALPHA, { op: 'start', spec: { name: 'web', application: process.execPath, args: ['-e', `Bun.serve({hostname:'127.0.0.1',port:${allocated.port},fetch:()=>new Response('process')})`], cwd: '.', env: {}, pty: false, restart: 'no', persist: true, detached: false, ready: { port: allocated.port, host: '127.0.0.1', timeoutMs: 10_000 } } }), alpha.local, AbortSignal.timeout(20_000));
    expect(started?.type === 'text' ? JSON.parse(started.text) : null).toMatchObject({ op: 'start', url: null, machineUrl: 'https://web--alpha-aaaa--workspace--test-srv.gssh.dev' });
    expect(registry.leases.has(WEB)).toBe(false);
    expect(registry.pointers.has(WEB)).toBe(false);
    expect(await fetchVia(alpha.manager, ALPHA, WEB)).toBeNull();

    const [pinned] = await proc(dispatch(ALPHA, { op: 'pin', name: 'web' }), alpha.local, AbortSignal.timeout(20_000));
    expect(pinned?.type === 'text' ? JSON.parse(pinned.text) : null).toMatchObject({ op: 'pin', source: 'process', url: `https://${WEB}` });
    expect(registry.pointers.get(WEB)).toMatchObject({ machineId: ALPHA, source: 'process', serviceName: 'web' });
    expect(await fetchVia(alpha.manager, ALPHA, WEB)).toBe('process');
    const listed = RuntimeServiceSchema.array().parse(await cacheServiceOperation(alpha.manager, alpha.local, { op: 'list' }));
    expect(listed.find(service => service.source === 'process')).toMatchObject({ name: 'web', url: `https://${WEB}` });
    expect(listed.find(service => service.source === 'declared')).toMatchObject({ name: 'web', url: null, ports: [{ name: 'http', servedBy: 'alpha' }, { name: 'admin', servedBy: null }] });

    // The machine restarts and the old lease lapses: its rehydrate leases the pinned workspace URL for the process again.
    registry.leases.delete(WEB);
    restarted = new WorkspaceServiceManager(noCheckouts, terminals, ALPHA, join(root, 'alpha-runtime'), 'gssh.dev', 'test', registry.authority(ALPHA), async () => trust);
    await rehydrateServiceRoutes(restarted, alpha.local);
    expect(registry.leases.get(WEB)).toMatchObject({ machineId: ALPHA, source: 'process', serviceName: 'web' });
    expect(await fetchVia(restarted, ALPHA, WEB)).toBe('process');
  } finally {
    await proc(dispatch(ALPHA, { op: 'stop', name: 'web' }), alpha.local, AbortSignal.timeout(5_000)).catch(() => {});
    await Promise.all([alpha.manager.dispose(), restarted?.dispose()]);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
