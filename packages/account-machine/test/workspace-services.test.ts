import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSpaceDatabase } from '@gitspace/core';
import type { WorkspaceTerminalView } from '../src/workspace-hub.js';
import { WorkspaceServiceManager } from '../src/workspace-services.js';

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
        const server = Bun.serve({ hostname: '127.0.0.1', port: observedPort, fetch: () => Response.json({ service: serviceName, port: observedPort }) });
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
    const manager = new WorkspaceServiceManager(database, terminals, 'machine-a', join(root, 'runtime'), 'gssh.dev', 'brad');
    const before = await manager.list('space-a');
    expect(before[0]).toMatchObject({ name: 'web', state: 'stopped', port: null });
    const started = await manager.start('space-a', 'web');
    expect(started).toMatchObject({ state: 'running', port: observedPort, url: 'https://web--space-a--brad-srv.gssh.dev' });
    const local = await fetch(`http://127.0.0.1:${observedPort}/healthz`);
    expect(await local.json()).toEqual({ service: 'web', port: observedPort });
    const proxied = await manager.proxy(new Request('http://web--space-a--brad-srv.gssh.dev/healthz'));
    expect(proxied?.status).toBe(200);
    expect(await proxied?.json()).toEqual({ service: 'web', port: observedPort });
    await manager.stop('space-a', 'web');
    const restarted = await manager.start('space-a', 'web');
    expect(restarted.port).toBe(observedPort);
  });
});
