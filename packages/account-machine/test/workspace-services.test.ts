import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSpaceDatabase } from '@gitspace/core';
import type { WorkspaceTerminalView } from '../src/workspace-hub.js';
import { WorkspaceServiceManager } from '../src/workspace-services.js';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { SERVICE_ASSERTION_HEADER, signServiceAssertion } from '@gitspace/protocol/service-access';
import { openServiceForward } from '../src/service-forward.js';

const roots: string[] = [];
interface TestServer {
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}
const servers: TestServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function terminal(spaceId: string, name: string, state: WorkspaceTerminalView['state'], owner: string): WorkspaceTerminalView {
  return { spaceId, name, id: name, kind: 'service', state, machineId: 'machine-a', owner, command: 'bun service.ts', cwd: '/', createdAt: new Date('2026-08-31T00:00:00.000Z'), exitCode: null };
}

describe('WorkspaceServiceManager', () => {
  it('strictly loads services, preserves the local port, and proxies the workspace-service hostname', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-service-'));
    roots.push(root);
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, '.gitspace'), { recursive: true });
    writeFileSync(join(workspace, '.gitspace', 'services.json'), JSON.stringify({ services: [{ name: 'web', command: 'bun', args: ['service.ts'], cwd: '.', env: {}, ports: [{ name: 'web', protocol: 'http' }] }] }));
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const project = database.createProject({ id: 'project-a', name: 'Project', repositoryPath: join(root, 'repo') });
    if (project.status === 'error') throw project.error;
    const created = database.createWorkspace({ id: 'space-a', projectId: 'project-a', name: 'Workspace', branch: 'main', rootPath: workspace });
    if (created.status === 'error') throw created.error;
    const possessed = database.possessSpace('space-a', 'machine-a');
    if (possessed.status === 'error') throw possessed.error;
    let active: WorkspaceTerminalView | null = null;
    let observedPort = 0;
    const terminals = {
      list: async () => active ? [active] : [],
      startService: async (spaceId: string, serviceName: string, _application: string, _args: string[], _cwd: string, env: Record<string, string>) => {
        observedPort = Number(env.PORT);
        const server = Bun.serve({ hostname: '127.0.0.1', port: observedPort, fetch: request => new URL(request.url).pathname === '/login' ? Response.json({ cookie: request.headers.get('cookie'), authorization: request.headers.get('authorization'), assertion: request.headers.get(SERVICE_ASSERTION_HEADER) }) : Response.json({ service: serviceName, port: observedPort }) });
        servers.push(server);
        active = terminal(spaceId, `gitspace-svc-${spaceId}-${serviceName}`, 'running', `gitspace:${spaceId}:service:${serviceName}`);
        return active;
      },
      stop: async () => {
        await servers.pop()?.stop(true);
        active = null;
        return terminal('space-a', 'gitspace-svc-space-a-web', 'exited', 'gitspace:space-a:service:web');
      },
    };
    const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
    const trust = { accountId: 'user-a', publicKey: credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))) };
    const manager = new WorkspaceServiceManager(database, terminals, 'machine-a', join(root, 'runtime'), 'gssh.dev', 'brad', undefined, async () => trust);
    async function signed(request: Request, accountId = 'user-a') {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set(SERVICE_ASSERTION_HEADER, await signServiceAssertion({ version: 1, accountId, hostname: url.hostname, machineId: 'machine-a', caller: { kind: 'device', accountId, deviceId: 'machine-b' }, method: request.method, target: url.pathname + url.search, issuedAt: Date.now(), expiresAt: Date.now() + 30_000, nonce: crypto.randomUUID() }, keys.privateKey));
      return new Request(request, { headers });
    }
    const before = await manager.list('space-a');
    expect(before[0]).toMatchObject({ name: 'web', state: 'stopped', port: null });
    const started = await manager.start('space-a', 'web');
    expect(started).toMatchObject({ state: 'running', port: observedPort, url: 'https://web--space-a--brad-srv.gssh.dev' });
    const local = await fetch(`http://127.0.0.1:${observedPort}/healthz`);
    expect(await local.json()).toEqual({ service: 'web', port: observedPort });
    const unauthenticated = await manager.proxy(new Request('http://web--space-a--brad-srv.gssh.dev/private'));
    expect(unauthenticated?.status).toBe(401);
    const forged = await manager.proxy(new Request('http://127.0.0.1/tunnel/machine-a/private', {
      headers: { 'x-forwarded-host': 'web--space-a--brad-srv.gssh.dev' },
    }));
    expect(forged?.status).toBe(401);
    const authorized = await signed(new Request('http://web--space-a--brad-srv.gssh.dev/healthz'));
    const proxied = await manager.proxy(authorized);
    expect(proxied?.status).toBe(200);
    expect(await proxied?.json()).toEqual({ service: 'web', port: observedPort });
    expect((await manager.proxy(authorized))?.status).toBe(401);
    expect((await manager.proxy(await signed(new Request('http://web--space-a--brad-srv.gssh.dev/healthz'), 'foreign-user')))?.status).toBe(401);
    const login = await manager.proxy(await signed(new Request('http://web--space-a--brad-srv.gssh.dev/login', { headers: { cookie: 'app_session=logged-in; __Host-gitspace-service=private', authorization: 'Bearer app-token' } })));
    expect(await login?.json()).toEqual({ cookie: 'app_session=logged-in', authorization: 'Bearer app-token', assertion: null });
    const forward = await openServiceForward({ hostname: 'web--space-a--brad-srv.gssh.dev', fetch: async request => await manager.proxy(await signed(request)) ?? new Response(null, { status: 404 }) });
    try {
      expect(new URL(forward.url).hostname).toBe('127.0.0.1');
      expect(await (await fetch(`${forward.url}/healthz`, { headers: forward.headers })).json()).toEqual({ service: 'web', port: observedPort });
    } finally { await forward.close(); }
    await manager.stop('space-a', 'web');
    const restarted = await manager.start('space-a', 'web');
    expect(restarted.port).toBe(observedPort);
    await manager.stopOwned('space-a');
    expect(await manager.proxy(new Request('http://web--space-a--brad-srv.gssh.dev/healthz'))).toBeNull();
    const allocationsPath = join(root, 'runtime', 'services', 'ports.json');
    const allocations = JSON.parse(readFileSync(allocationsPath, 'utf8'));
    allocations.allocations['machine-a:space-b:web:web'] = observedPort + 1;
    writeFileSync(allocationsPath, JSON.stringify(allocations));
    database.deleteWorkspace('space-a');
    await manager.forgetSpace('space-a');
    expect(JSON.parse(readFileSync(allocationsPath, 'utf8')).allocations).toEqual({ 'machine-a:space-b:web:web': observedPort + 1 });
    await manager.forgetSpace('space-b');
    expect(existsSync(allocationsPath)).toBe(false);
    database.close();
  });
});

describe('loopback service forwarding boundary', () => {
  it.each([
    ['missing secret', {}],
    ['wrong secret', { 'x-gitspace-forward-token': 'wrong' }],
    ['wrong Host', { host: 'attacker.example' }],
    ['foreign Origin', { origin: 'https://attacker.example' }],
    ['opaque Origin', { origin: 'null' }],
    ['original Origin without local Origin', { 'x-gitspace-forward-origin': 'https://trusted.example' }],
  ])('rejects %s before upstream access', async (_label, headers) => {
    let forwarded = false;
    const forward = await openServiceForward({ hostname: 'app--workspace--test-srv.gssh.dev', fetch: async () => { forwarded = true; return new Response('private'); } });
    try {
      const authenticated = _label === 'missing secret' ? {} : forward.headers;
      const response = await fetch(forward.url, { headers: { ...authenticated, ...headers } });
      expect(response.status).toBe(403);
      expect(forwarded).toBe(false);
    } finally { await forward.close(); }
  });
  it('restores token-bound browser Origin without exposing forwarding metadata', async () => {
    const forward = await openServiceForward({ hostname: 'api--workspace--test-srv.gssh.dev', fetch: async request => Response.json(Object.fromEntries(request.headers)) });
    try {
      const response = await fetch(forward.url, { headers: { ...forward.headers, origin: forward.url, 'x-gitspace-forward-origin': 'https://app--workspace--test-srv.gssh.dev' } });
      expect(response.status).toBe(200);
      const headers = await response.json();
      expect(headers.origin).toBe('https://app--workspace--test-srv.gssh.dev');
      expect(headers['x-gitspace-forward-origin']).toBeUndefined();
      expect(headers['x-gitspace-forward-token']).toBeUndefined();
    } finally { await forward.close(); }
  });
  it('authenticates HTTP without leaking the secret or hop-by-hop headers upstream', async () => {
    const forward = await openServiceForward({ hostname: 'app--workspace--test-srv.gssh.dev', fetch: async request => Response.json({ url: request.url, headers: Object.fromEntries(request.headers) }) });
    try {
      const response = await fetch(`${forward.url}/login?q=1`, { headers: { ...forward.headers, origin: forward.url, cookie: 'app_session=ok', authorization: 'Basic app-login', connection: 'x-hop', 'x-hop': 'private' } });
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.url).toBe('https://app--workspace--test-srv.gssh.dev/login?q=1');
      expect(body.headers.origin).toBe('https://app--workspace--test-srv.gssh.dev');
      expect(body.headers.cookie).toBe('app_session=ok');
      expect(body.headers.authorization).toBe('Basic app-login');
      for (const header of ['host', 'connection', 'x-hop', 'x-gitspace-forward-token']) expect(body.headers[header]).toBeUndefined();
    } finally { await forward.close(); }
  });
});
