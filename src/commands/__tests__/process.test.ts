/**
 * Process command tests - validates error paths throw SpacesError with exit code 1
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { SpacesError } from '../../types/errors.js';
import { buildProcessHostname } from '../../utils/hostnames.js';
import type { ProcessInstanceSpec } from '../../types/processes.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProcessPortAllocationPath } from '../../lib/processes/allocations.js';

// ============================================================================
// Mocks
// ============================================================================

// Mock tmux-lite CLI
const mockListSessions = mock<() => Promise<Array<{ id: string; name: string; cwd: string }>>>(
  () => Promise.resolve([])
);
mock.module('../../lib/tmux-lite/cli.js', () => ({
  listSessions: mockListSessions,
  listSessionsFromRunningServer: mockListSessions,
  createSession: mock(() => Promise.resolve({ id: 'sess-1', name: 'test' })),
  terminateSession: mock(() => Promise.resolve()),
  isProcessRunning: mock(() => false),
  isServerRunning: mock(() => Promise.resolve(true)),
}));

// Mock process manager
const mockGetProcessSpecs = mock<(workspacePath: string) => ProcessInstanceSpec[]>(() => []);
const mockStartProcessInstance = mock(() => Promise.resolve({ sessionId: 'sess-1', created: true }));
const mockStopProcessInstance = mock(() => Promise.resolve());
const mockListProcessSessions = mock<
  () => Promise<Array<{ sessionId: string; processName: string; instance: number; name: string; workspacePath: string }>>
>(() => Promise.resolve([]));
const mockOpenBrowserUrl = mock(() => Promise.resolve({ ok: true as const }));

mock.module('../../lib/processes/manager.js', () => ({
  getProcessSpecs: mockGetProcessSpecs,
  startProcessInstance: mockStartProcessInstance,
  stopProcessInstance: mockStopProcessInstance,
  listProcessSessions: mockListProcessSessions,
}));

mock.module('../../utils/open-browser.js', () => ({
  openBrowserUrl: mockOpenBrowserUrl,
}));

// Import after mocking
const { listProcesses, startProcess, stopProcess, attachProcess, openProcess } = await import('../process.js');

// Real hosting chain. `getWorkspaceRoot()`, `getSpacesDir()` and
// `getTmuxLitePaths()` all read env at CALL time, so pointing them at a temp root
// exercises host.json parsing, the hosting-state file and the registered-route
// gate inside `resolveHostedServiceUrl`. The previous fake reimplemented that
// function and skipped all three checks, so it asserted URLs production would
// never produce.
const gitspaceRoot = mkdtempSync(join(tmpdir(), 'gssh-process-root-'));
process.env.GITSPACE_WORKSPACE_ROOT = gitspaceRoot;
process.env.TMUX_LITE_SESSION_DIR = join(gitspaceRoot, 'sessions');

const HOSTING_SUBDOMAIN = 'brad';
const HOSTING_DOMAIN = 'gitspace.sh';
const HOSTING_MACHINE = 'macbook';

function hostedHostname(workspaceId: string, processName: string, instance: number, portLabel: string): string {
  return buildProcessHostname(HOSTING_DOMAIN, HOSTING_SUBDOMAIN, workspaceId, processName, instance, portLabel, HOSTING_MACHINE);
}

function createWorkspace(name: string): string {
  const workspacePath = join(gitspaceRoot, 'project', 'workspaces', name);
  mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

/** Persist what a start would have allocated; reporting reads this and never allocates. */
function writeAllocatedPorts(
  workspacePath: string,
  processName: string,
  instance: number,
  ports: Array<{ name: string; port: number; protocol: 'http' | 'tcp' }>,
): void {
  const allocationPath = getProcessPortAllocationPath(workspacePath);
  mkdirSync(dirname(allocationPath), { recursive: true });
  writeFileSync(allocationPath, JSON.stringify({
    version: 1,
    allocations: Object.fromEntries(ports.map((port) => [
      `${processName}:${instance}:${port.name}`,
      { port: port.port, protocol: port.protocol, updatedAt: Date.now() },
    ])),
  }), 'utf-8');
}

/** Register hosting so `resolveHostedServiceUrl` can resolve a remote URL. */
function enableHosting(
  routes: Array<{ workspaceId: string; processName: string; instance: number; portLabel: string }>,
): void {
  writeFileSync(join(gitspaceRoot, 'host.json'), JSON.stringify({
    subdomain: HOSTING_SUBDOMAIN,
    subdomains: [HOSTING_SUBDOMAIN],
    serveNamespaces: { [HOSTING_SUBDOMAIN]: { domain: HOSTING_DOMAIN } },
    createdAt: Date.now(),
  }), 'utf-8');

  const sessionDir = join(gitspaceRoot, 'sessions');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, '.gitspace-hosting.json'), JSON.stringify({
    baseHost: `${HOSTING_SUBDOMAIN}.${HOSTING_DOMAIN}`,
    machineName: HOSTING_MACHINE,
    enabled: true,
    updatedAt: Date.now(),
  }), 'utf-8');

  const routesDir = join(gitspaceRoot, '.tmux-hosting');
  mkdirSync(routesDir, { recursive: true });
  writeFileSync(join(routesDir, 'hosted-routes.json'), JSON.stringify(
    routes.map((route) => ({
      hostname: hostedHostname(route.workspaceId, route.processName, route.instance, route.portLabel),
      service: `${route.processName}:${route.instance}:${route.portLabel}`,
    })),
  ), 'utf-8');
}

/** Drop every hosting artefact so only localhost URLs remain resolvable. */
function disableHosting(): void {
  rmSync(join(gitspaceRoot, 'host.json'), { force: true });
  rmSync(join(gitspaceRoot, 'sessions', '.gitspace-hosting.json'), { force: true });
  rmSync(join(gitspaceRoot, '.tmux-hosting'), { recursive: true, force: true });
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

// ============================================================================
// startProcess
// ============================================================================

describe('startProcess', () => {
  beforeEach(() => {
    mockGetProcessSpecs.mockReset();
    mockStartProcessInstance.mockReset();
  });

  it('should throw SpacesError with exit code 1 when --name is missing', async () => {
    try {
      await startProcess({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).code).toBe('USER_ERROR');
      expect((err as SpacesError).message).toContain('--name');
    }
  });

  it('should throw SpacesError when process name is not found in specs', async () => {
    mockGetProcessSpecs.mockImplementation(() => []);

    try {
      await startProcess({ name: 'nonexistent' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).message).toContain('nonexistent');
    }
  });

  it('should start process when spec exists', async () => {
    const spec: ProcessInstanceSpec = {
      name: 'web',
      instance: 1,
      definition: { name: 'web', command: 'npm start' },
    };
    mockGetProcessSpecs.mockImplementation(() => [spec]);
    mockStartProcessInstance.mockResolvedValue({ sessionId: 'sess-1', created: true });

    // Should not throw
    await startProcess({ name: 'web' });

    expect(mockStartProcessInstance).toHaveBeenCalledTimes(1);
  });

  it('starts declared services without using repo-pinned ports', async () => {
    const spec: ProcessInstanceSpec = {
      name: 'web',
      instance: 1,
      definition: { name: 'web', command: 'npm start', ports: [{ name: 'app', protocol: 'http' }] },
    };
    mockGetProcessSpecs.mockImplementation(() => [spec]);
    mockStartProcessInstance.mockResolvedValue({ sessionId: 'sess-1', created: true });

    await startProcess({ name: 'web' });

    expect(mockStartProcessInstance).toHaveBeenCalledTimes(1);
  });

  it('should throw disabled error when process exists with instances: 0', async () => {
    mockGetProcessSpecs.mockImplementation(() => []);
    const workspacePath = mkdtempSync(join(tmpdir(), 'gssh-process-test-'));
    const gitspaceDir = join(workspacePath, '.gitspace');
    mkdirSync(gitspaceDir, { recursive: true });
    writeFileSync(
      join(gitspaceDir, 'processes.json'),
      JSON.stringify({ processes: [{ name: 'web', command: 'npm start', instances: 0 }] }),
      'utf-8'
    );

    try {
      await startProcess({ name: 'web', workspace: workspacePath });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).message).toContain('Process is disabled');
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// stopProcess
// ============================================================================

describe('stopProcess', () => {
  beforeEach(() => {
    mockGetProcessSpecs.mockReset();
    mockStopProcessInstance.mockReset();
  });

  it('should throw SpacesError with exit code 1 when --name is missing', async () => {
    try {
      await stopProcess({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).message).toContain('--name');
    }
  });

  it('should throw SpacesError when process name is not found', async () => {
    mockGetProcessSpecs.mockImplementation(() => []);

    try {
      await stopProcess({ name: 'nonexistent' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).message).toContain('nonexistent');
    }
  });

  it('should stop process when spec exists', async () => {
    const spec: ProcessInstanceSpec = {
      name: 'web',
      instance: 1,
      definition: { name: 'web', command: 'npm start' },
    };
    mockGetProcessSpecs.mockImplementation(() => [spec]);
    mockStopProcessInstance.mockResolvedValue(undefined);

    await stopProcess({ name: 'web' });

    expect(mockStopProcessInstance).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// attachProcess
// ============================================================================

describe('attachProcess', () => {
  beforeEach(() => {
    mockListProcessSessions.mockReset();
    mockListSessions.mockReset();
  });

  it('should throw SpacesError with exit code 1 when --name is missing', async () => {
    try {
      await attachProcess({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).message).toContain('--name');
    }
  });

  it('should throw SpacesError when process is not running', async () => {
    mockListProcessSessions.mockImplementation(() => Promise.resolve([]));

    try {
      await attachProcess({ name: 'web' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).message).toContain('not running');
    }
  });

  it('should throw SYSTEM_ERROR when session is not found in tmux', async () => {
    mockListProcessSessions.mockImplementation(() =>
      Promise.resolve([
        { sessionId: 'sess-99', processName: 'web', instance: 1, name: 'proc:ws:web:1', workspacePath: '/tmp' },
      ])
    );
    mockListSessions.mockImplementation(() => Promise.resolve([]));

    try {
      await attachProcess({ name: 'web' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(2);
      expect((err as SpacesError).code).toBe('SYSTEM_ERROR');
    }
  });

  it('should succeed when process is running and session exists', async () => {
    mockListProcessSessions.mockImplementation(() =>
      Promise.resolve([
        { sessionId: 'sess-1', processName: 'web', instance: 1, name: 'proc:ws:web:1', workspacePath: '/tmp' },
      ])
    );
    mockListSessions.mockImplementation(() =>
      Promise.resolve([{ id: 'sess-1', name: 'proc:ws:web:1', cwd: '/tmp' }])
    );

    // Should not throw
    await attachProcess({ name: 'web' });
  });
});

// ============================================================================
// listProcesses
// ============================================================================

describe('listProcesses', () => {
  beforeEach(() => {
    mockGetProcessSpecs.mockReset();
    mockListProcessSessions.mockReset();
    disableHosting();
  });

  it('should not throw when no processes are configured', async () => {
    mockGetProcessSpecs.mockImplementation(() => []);
    mockListProcessSessions.mockImplementation(() => Promise.resolve([]));

    await listProcesses({});
  });

  it('reports the localhost url and the hosted url for routed http ports', async () => {
    const workspacePath = createWorkspace('demo');
    mockGetProcessSpecs.mockImplementation(() => [{
      name: 'web',
      instance: 1,
      definition: {
        name: 'web',
        command: 'npm start',
        ports: [
          { name: 'app', protocol: 'http' },
          { name: 'tcp-admin', protocol: 'tcp' },
        ],
      },
    }]);
    mockListProcessSessions.mockImplementation(() => Promise.resolve([]));
    writeAllocatedPorts(workspacePath, 'web', 1, [
      { name: 'app', port: 3000, protocol: 'http' },
      { name: 'tcp-admin', port: 7000, protocol: 'tcp' },
    ]);
    enableHosting([{ workspaceId: 'demo', processName: 'web', instance: 1, portLabel: 'app' }]);

    const output = await captureStdout(() => listProcesses({ workspace: workspacePath }));

    expect(output).toContain('local:  http://localhost:3000');
    expect(output).toContain(`remote: http://${hostedHostname('demo', 'web', 1, 'app')}`);
    // tcp gets no hosted route, so it stays local-only.
    expect(output).toContain('local:  tcp://localhost:7000');
    expect(output).toContain('remote: not configured');
  });

  it('reports ports as unallocated when the process has never started', async () => {
    const workspacePath = createWorkspace('never-started');
    mockGetProcessSpecs.mockImplementation(() => [{
      name: 'web',
      instance: 1,
      definition: { name: 'web', command: 'npm start', ports: [{ name: 'app', protocol: 'http' }] },
    }]);
    mockListProcessSessions.mockImplementation(() => Promise.resolve([]));

    const output = await captureStdout(() => listProcesses({ workspace: workspacePath }));

    expect(output).toContain('ports not allocated yet');
  });
});

describe('openProcess', () => {
  beforeEach(() => {
    mockGetProcessSpecs.mockReset();
    mockOpenBrowserUrl.mockReset();
    mockOpenBrowserUrl.mockResolvedValue({ ok: true });
    disableHosting();
  });

  it('opens hosted url by default when available', async () => {
    const workspacePath = createWorkspace('demo');
    mockGetProcessSpecs.mockImplementation(() => [{
      name: 'web',
      instance: 1,
      definition: { name: 'web', command: 'npm start', ports: [{ name: 'app', protocol: 'http' }] },
    }]);
    writeAllocatedPorts(workspacePath, 'web', 1, [{ name: 'app', port: 3000, protocol: 'http' }]);
    enableHosting([{ workspaceId: 'demo', processName: 'web', instance: 1, portLabel: 'app' }]);

    await openProcess({ workspace: workspacePath, name: 'web' });

    expect(mockOpenBrowserUrl).toHaveBeenCalledWith(`http://${hostedHostname('demo', 'web', 1, 'app')}`);
  });

  it('opens all configured http ports and skips tcp ports with --all', async () => {
    const workspacePath = createWorkspace('demo');
    mockGetProcessSpecs.mockImplementation(() => [{
      name: 'web',
      instance: 1,
      definition: {
        name: 'web',
        command: 'npm start',
        ports: [
          { name: 'app', protocol: 'http' },
          { name: 'admin', protocol: 'http' },
          { name: 'tcp-admin', protocol: 'tcp' },
        ],
      },
    }]);
    writeAllocatedPorts(workspacePath, 'web', 1, [
      { name: 'app', port: 3000, protocol: 'http' },
      { name: 'admin', port: 3001, protocol: 'http' },
      { name: 'tcp-admin', port: 7000, protocol: 'tcp' },
    ]);
    enableHosting([
      { workspaceId: 'demo', processName: 'web', instance: 1, portLabel: 'app' },
      { workspaceId: 'demo', processName: 'web', instance: 1, portLabel: 'admin' },
    ]);

    await openProcess({ workspace: workspacePath, name: 'web', all: true });

    expect(mockOpenBrowserUrl).toHaveBeenCalledTimes(2);
    expect(mockOpenBrowserUrl).toHaveBeenNthCalledWith(1, `http://${hostedHostname('demo', 'web', 1, 'app')}`);
    expect(mockOpenBrowserUrl).toHaveBeenNthCalledWith(2, `http://${hostedHostname('demo', 'web', 1, 'admin')}`);
  });

  it('falls back to localhost when hosting is not configured', async () => {
    const workspacePath = createWorkspace('demo');
    mockGetProcessSpecs.mockImplementation(() => [{
      name: 'web',
      instance: 1,
      definition: { name: 'web', command: 'npm start', ports: [{ name: 'app', protocol: 'http' }] },
    }]);
    writeAllocatedPorts(workspacePath, 'web', 1, [{ name: 'app', port: 3000, protocol: 'http' }]);

    await openProcess({ workspace: workspacePath, name: 'web' });

    expect(mockOpenBrowserUrl).toHaveBeenCalledWith('http://localhost:3000');
  });

  it('falls back to localhost when hosting is up but this hostname has no registered route', async () => {
    const workspacePath = createWorkspace('demo');
    mockGetProcessSpecs.mockImplementation(() => [{
      name: 'web',
      instance: 1,
      definition: { name: 'web', command: 'npm start', ports: [{ name: 'app', protocol: 'http' }] },
    }]);
    writeAllocatedPorts(workspacePath, 'web', 1, [{ name: 'app', port: 3000, protocol: 'http' }]);
    // Hosting is enabled, but only for a different workspace — no route matches.
    enableHosting([{ workspaceId: 'other', processName: 'web', instance: 1, portLabel: 'app' }]);

    await openProcess({ workspace: workspacePath, name: 'web' });

    expect(mockOpenBrowserUrl).toHaveBeenCalledWith('http://localhost:3000');
  });
});
