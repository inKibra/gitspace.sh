/**
 * Process command tests - validates error paths throw SpacesError with exit code 1
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { SpacesError } from '../../types/errors.js';
import { buildProcessHostname } from '../../utils/hostnames.js';
import type { ProcessInstanceSpec } from '../../types/processes.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
const mockReadTmuxHostingState = mock<() => { baseHost?: string; machineName?: string; enabled: boolean; updatedAt: number } | null>(() => null);
const mockResolveProcessRuntimePorts = mock(() => Promise.resolve([] as Array<{ instance: number; name: string; port: number; protocol?: 'http' | 'tcp' }>));
const mockResolveHostedServiceUrl = mock((args: { baseHost?: string; machineName?: string; workspaceId: string; processName: string; instance: number; portLabel: string; protocol: 'http' | 'tcp' }) => {
  return args.protocol === 'http' && args.baseHost
    ? `http://${buildProcessHostname('gitspace.sh', 'brad', args.workspaceId, args.processName, args.instance, args.portLabel, args.machineName)}`
    : undefined;
});

mock.module('../../lib/processes/manager.js', () => ({
  getProcessSpecs: mockGetProcessSpecs,
  startProcessInstance: mockStartProcessInstance,
  stopProcessInstance: mockStopProcessInstance,
  listProcessSessions: mockListProcessSessions,
}));

mock.module('../../utils/open-browser.js', () => ({
  openBrowserUrl: mockOpenBrowserUrl,
}));

mock.module('../../lib/tmux-lite/hosting/state.js', () => ({
  readTmuxHostingState: mockReadTmuxHostingState,
  writeTmuxHostingState: mock(() => ({ enabled: true, updatedAt: Date.now() })),
  resolveTmuxHostingState: mock(() => ({ enabled: false, updatedAt: Date.now() })),
  clearTmuxHostingState: mock(() => undefined),
}));

mock.module('../../lib/tmux-lite/hosting/routes.js', () => ({
  resolveHostedServiceUrl: mockResolveHostedServiceUrl,
}));

mock.module('../../lib/processes/allocations.js', () => ({
  reconcileProcessPortAllocations: mock(() => undefined),
  resolveProcessRuntimePorts: mockResolveProcessRuntimePorts,
}));

// Import after mocking
const { listProcesses, startProcess, stopProcess, attachProcess, openProcess } = await import('../process.js');

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
// listProcesses (no error paths, just smoke test)
// ============================================================================

describe('listProcesses', () => {
  beforeEach(() => {
    mockGetProcessSpecs.mockReset();
    mockListProcessSessions.mockReset();
    mockReadTmuxHostingState.mockReset();
    mockResolveProcessRuntimePorts.mockReset();
  });

  it('should not throw when no processes are configured', async () => {
    mockGetProcessSpecs.mockImplementation(() => []);
    mockListProcessSessions.mockImplementation(() => Promise.resolve([]));

    // Should not throw
    await listProcesses({});
  });

  it('should include local and remote urls for configured ports', async () => {
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
    mockReadTmuxHostingState.mockImplementation(() => ({ baseHost: 'brad.gitspace.sh', machineName: 'macbook', enabled: true, updatedAt: Date.now() }));
    mockResolveProcessRuntimePorts.mockResolvedValue([
      { instance: 1, name: 'app', port: 3000, protocol: 'http' },
      { instance: 1, name: 'tcp-admin', port: 7000, protocol: 'tcp' },
    ]);

    await listProcesses({ workspace: '/tmp/project/workspaces/demo' });
  });
});

describe('openProcess', () => {
  beforeEach(() => {
    mockGetProcessSpecs.mockReset();
    mockOpenBrowserUrl.mockReset();
    mockReadTmuxHostingState.mockReset();
    mockResolveProcessRuntimePorts.mockReset();
    mockOpenBrowserUrl.mockResolvedValue({ ok: true });
    mockResolveHostedServiceUrl.mockReset();
    mockResolveHostedServiceUrl.mockImplementation((args) => args.protocol === 'http' && args.baseHost
      ? `http://${buildProcessHostname('gitspace.sh', 'brad', args.workspaceId, args.processName, args.instance, args.portLabel, args.machineName)}`
      : undefined);
  });

  it('opens hosted url by default when available', async () => {
    mockGetProcessSpecs.mockImplementation(() => [{
      name: 'web',
      instance: 1,
      definition: { name: 'web', command: 'npm start', ports: [{ name: 'app', protocol: 'http' }] },
    }]);
    mockReadTmuxHostingState.mockImplementation(() => ({ baseHost: 'brad.gitspace.sh', machineName: 'macbook', enabled: true, updatedAt: Date.now() }));
    mockResolveProcessRuntimePorts.mockResolvedValue([
      { instance: 1, name: 'app', port: 3000, protocol: 'http' },
    ]);

    await openProcess({ workspace: '/tmp/project/workspaces/demo', name: 'web' });

    expect(mockOpenBrowserUrl).toHaveBeenCalledWith(`http://${buildProcessHostname('gitspace.sh', 'brad', 'demo', 'web', 1, 'app', 'macbook')}`);
  });

  it('opens all configured http ports and skips tcp ports with --all', async () => {
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
    mockReadTmuxHostingState.mockImplementation(() => ({ baseHost: 'brad.gitspace.sh', machineName: 'macbook', enabled: true, updatedAt: Date.now() }));
    mockResolveProcessRuntimePorts.mockResolvedValue([
      { instance: 1, name: 'app', port: 3000, protocol: 'http' },
      { instance: 1, name: 'admin', port: 3001, protocol: 'http' },
      { instance: 1, name: 'tcp-admin', port: 7000, protocol: 'tcp' },
    ]);

    await openProcess({ workspace: '/tmp/project/workspaces/demo', name: 'web', all: true });

    expect(mockOpenBrowserUrl).toHaveBeenCalledTimes(2);
    expect(mockOpenBrowserUrl).toHaveBeenNthCalledWith(1, `http://${buildProcessHostname('gitspace.sh', 'brad', 'demo', 'web', 1, 'app', 'macbook')}`);
    expect(mockOpenBrowserUrl).toHaveBeenNthCalledWith(2, `http://${buildProcessHostname('gitspace.sh', 'brad', 'demo', 'web', 1, 'admin', 'macbook')}`);
  });

  it('falls back to localhost when no hosted url exists', async () => {
    mockGetProcessSpecs.mockImplementation(() => [{
      name: 'web',
      instance: 1,
      definition: { name: 'web', command: 'npm start', ports: [{ name: 'app', protocol: 'http' }] },
    }]);
    mockReadTmuxHostingState.mockImplementation(() => null);
    mockResolveProcessRuntimePorts.mockResolvedValue([
      { instance: 1, name: 'app', port: 3000, protocol: 'http' },
    ]);

    await openProcess({ workspace: '/tmp/project/workspaces/demo', name: 'web' });

    expect(mockOpenBrowserUrl).toHaveBeenCalledWith('http://localhost:3000');
  });
});
