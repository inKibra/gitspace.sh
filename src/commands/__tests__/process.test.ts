/**
 * Process command tests - validates error paths throw SpacesError with exit code 1
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { SpacesError } from '../../types/errors.js';
import type { ProcessInstanceSpec } from '../../types/processes.js';

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
}));

// Mock process manager
const mockGetProcessSpecs = mock<(workspacePath: string) => ProcessInstanceSpec[]>(() => []);
const mockStartProcessInstance = mock(() => Promise.resolve({ sessionId: 'sess-1', created: true }));
const mockStopProcessInstance = mock(() => Promise.resolve());
const mockListProcessSessions = mock<
  () => Promise<Array<{ sessionId: string; processName: string; instance: number; name: string; workspacePath: string }>>
>(() => Promise.resolve([]));

mock.module('../../lib/processes/manager.js', () => ({
  getProcessSpecs: mockGetProcessSpecs,
  startProcessInstance: mockStartProcessInstance,
  stopProcessInstance: mockStopProcessInstance,
  listProcessSessions: mockListProcessSessions,
}));

// Import after mocking
const { listProcesses, startProcess, stopProcess, attachProcess } = await import('../process.js');

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
  });

  it('should not throw when no processes are configured', async () => {
    mockGetProcessSpecs.mockImplementation(() => []);
    mockListProcessSessions.mockImplementation(() => Promise.resolve([]));

    // Should not throw
    await listProcesses({});
  });
});
