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
  createSession: mock(() => Promise.resolve({ id: 'sess-1', name: 'test' })),
  killSession: mock(() => Promise.resolve()),
  isProcessRunning: mock(() => false),
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
const mockSelectOne = mock(() => Promise.resolve<'resolve' | 'cancel'>('resolve'));
const mockResolvePortConflict = mock(() => Promise.resolve());
class MockPortConflictError extends Error {
  code = 'PORT_CONFLICT';
  conflicts;
  constructor(conflicts: Array<{ port: number; protocol: 'http' | 'tcp'; pid: number; command?: string; user?: string; managedSessionId?: string; managedProcessName?: string; managedInstance?: number; managedWorkspaceId?: string }>) {
    super('port conflict');
    this.name = 'PortConflictError';
    this.conflicts = conflicts;
  }
}

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

const realPrompts = await import('../../utils/prompts.js');
mock.module('../../utils/prompts.js', () => ({
  ...realPrompts,
  selectOne: mockSelectOne,
}));

const realPorts = await import('../../lib/processes/ports.js');
mock.module('../../lib/processes/ports.js', () => ({
  ...realPorts,
  PortConflictError: MockPortConflictError,
  resolvePortConflict: mockResolvePortConflict,
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
    mockSelectOne.mockReset();
    mockResolvePortConflict.mockReset();
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

  it('resolves port conflicts and retries start', async () => {
    const spec: ProcessInstanceSpec = {
      name: 'web',
      instance: 1,
      definition: { name: 'web', command: 'npm start', ports: [{ port: 3000, protocol: 'http' }] },
    };
    mockGetProcessSpecs.mockImplementation(() => [spec]);
    mockStartProcessInstance
      .mockRejectedValueOnce(new MockPortConflictError([{ port: 3000, protocol: 'http', pid: 1234, command: 'node' }]))
      .mockResolvedValueOnce({ sessionId: 'sess-1', created: true });
    mockSelectOne.mockResolvedValue('resolve');

    await startProcess({ name: 'web' });

    expect(mockSelectOne).toHaveBeenCalledTimes(1);
    expect(mockResolvePortConflict).toHaveBeenCalledTimes(1);
    expect(mockStartProcessInstance).toHaveBeenCalledTimes(2);
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
          { name: 'app', port: 3000, protocol: 'http' },
          { name: 'tcp-admin', port: 7000, protocol: 'tcp' },
        ],
      },
    }]);
    mockListProcessSessions.mockImplementation(() => Promise.resolve([]));
    mockReadTmuxHostingState.mockImplementation(() => ({ baseHost: 'brad.serve.gitspace.sh', machineName: 'macbook', enabled: true, updatedAt: Date.now() }));

    await listProcesses({ workspace: '/tmp/project/workspaces/demo' });
  });
});

describe('openProcess', () => {
  beforeEach(() => {
    mockGetProcessSpecs.mockReset();
    mockOpenBrowserUrl.mockReset();
    mockReadTmuxHostingState.mockReset();
    mockOpenBrowserUrl.mockResolvedValue({ ok: true });
  });

  it('opens hosted url by default when available', async () => {
    mockGetProcessSpecs.mockImplementation(() => [{
      name: 'web',
      instance: 1,
      definition: { name: 'web', command: 'npm start', ports: [{ name: 'app', port: 3000, protocol: 'http' }] },
    }]);
    mockReadTmuxHostingState.mockImplementation(() => ({ baseHost: 'brad.serve.gitspace.sh', machineName: 'macbook', enabled: true, updatedAt: Date.now() }));

    await openProcess({ workspace: '/tmp/project/workspaces/demo', name: 'web' });

    expect(mockOpenBrowserUrl).toHaveBeenCalledWith(`https://${buildProcessHostname('brad.serve.gitspace.sh', 'demo', 'web', 1, 'app', 'macbook')}`);
  });

  it('opens all configured http ports and skips tcp ports with --all', async () => {
    mockGetProcessSpecs.mockImplementation(() => [{
      name: 'web',
      instance: 1,
      definition: {
        name: 'web',
        command: 'npm start',
        ports: [
          { name: 'app', port: 3000, protocol: 'http' },
          { name: 'admin', port: 3001, protocol: 'http' },
          { name: 'tcp-admin', port: 7000, protocol: 'tcp' },
        ],
      },
    }]);
    mockReadTmuxHostingState.mockImplementation(() => ({ baseHost: 'brad.serve.gitspace.sh', machineName: 'macbook', enabled: true, updatedAt: Date.now() }));

    await openProcess({ workspace: '/tmp/project/workspaces/demo', name: 'web', all: true });

    expect(mockOpenBrowserUrl).toHaveBeenCalledTimes(2);
    expect(mockOpenBrowserUrl).toHaveBeenNthCalledWith(1, `https://${buildProcessHostname('brad.serve.gitspace.sh', 'demo', 'web', 1, 'app', 'macbook')}`);
    expect(mockOpenBrowserUrl).toHaveBeenNthCalledWith(2, `https://${buildProcessHostname('brad.serve.gitspace.sh', 'demo', 'web', 1, 'admin', 'macbook')}`);
  });

  it('falls back to localhost when no hosted url exists', async () => {
    mockGetProcessSpecs.mockImplementation(() => [{
      name: 'web',
      instance: 1,
      definition: { name: 'web', command: 'npm start', ports: [{ port: 3000, protocol: 'http' }] },
    }]);
    mockReadTmuxHostingState.mockImplementation(() => null);

    await openProcess({ workspace: '/tmp/project/workspaces/demo', name: 'web' });

    expect(mockOpenBrowserUrl).toHaveBeenCalledWith('http://localhost:3000');
  });
});
