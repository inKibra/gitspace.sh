/**
 * Events command tests - validates error paths throw SpacesError with exit code 1
 */

import { describe, expect, it, mock, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as realConfig from '../../core/config.js';
import * as realCli from '../../lib/tmux-lite/cli.js';
import * as realEventPaths from '../../lib/events/paths.js';
import * as realEventReader from '../../lib/events/reader.js';
import { SpacesError } from '../../types/errors.js';

// ============================================================================
// Mocks
// ============================================================================

// Mock config
const mockGetCurrentProject = mock<() => string | null>(() => realConfig.getCurrentProject());
mock.module('../../core/config.js', () => ({
  ...realConfig,
  getCurrentProject: mockGetCurrentProject,
  getGitspaceDir: mock(() => '/tmp/gitspace'),
}));

// Mock tmux-lite CLI
const mockListSessions = mock<() => Promise<Array<{ id: string; name: string; cwd: string }>>>(
  () => realCli.listSessions()
);
mock.module('../../lib/tmux-lite/cli.js', () => ({
  ...realCli,
  listSessions: mockListSessions,
}));

// Mock events paths
const mockGetProcessEventsDir = mock<(workspacePath: string, processName: string) => string>(
  (workspacePath: string, processName: string) =>
    realEventPaths.getProcessEventsDir(workspacePath, processName)
);
const mockListProcessEventsDirs = mock<(workspacePath: string) => string[]>(
  (workspacePath: string) => realEventPaths.listProcessEventsDirs(workspacePath)
);
mock.module('../../lib/events/paths.js', () => ({
  ...realEventPaths,
  getProcessEventsDir: mockGetProcessEventsDir,
  listProcessEventsDirs: mockListProcessEventsDirs,
}));

// Mock events reader
const mockReadWideEvents = mock<(...args: unknown[]) => unknown[]>((...args: unknown[]) =>
  realEventReader.readWideEvents(...args as Parameters<typeof realEventReader.readWideEvents>)
);
mock.module('../../lib/events/reader.js', () => ({
  ...realEventReader,
  readWideEvents: mockReadWideEvents,
}));

const tempDirs: string[] = [];

function makeTempEventsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gssh-events-cmd-'));
  tempDirs.push(dir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

afterAll(() => {
  mock.module('../../core/config.js', () => ({
    ...realConfig,
  }));
  mock.module('../../lib/tmux-lite/cli.js', () => ({
    ...realCli,
  }));
  mock.module('../../lib/events/paths.js', () => ({
    ...realEventPaths,
  }));
  mock.module('../../lib/events/reader.js', () => ({
    ...realEventReader,
  }));

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// Import after mocking
const { listEvents, showEvent, tailEvents } = await import('../events.js');

// ============================================================================
// resolveEventsDir errors (shared by listEvents, showEvent, tailEvents)
// ============================================================================

describe('events: no current project', () => {
  beforeEach(() => {
    mockGetCurrentProject.mockImplementation(() => null);
  });

  it('listEvents should throw SpacesError when no current project', async () => {
    try {
      await listEvents({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).code).toBe('USER_ERROR');
      expect((err as SpacesError).message).toContain('No current project');
    }
  });

  it('tailEvents should throw SpacesError when no current project', async () => {
    try {
      await tailEvents({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
    }
  });
});

describe('events: session not found', () => {
  beforeEach(() => {
    mockGetCurrentProject.mockImplementation(() => 'my-project');
    mockListSessions.mockImplementation(() => Promise.resolve([]));
  });

  it('listEvents should throw SpacesError when no sessions exist', async () => {
    try {
      await listEvents({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).message).toContain('No active sessions found');
    }
  });

  it('listEvents should throw SpacesError when named session does not exist', async () => {
    mockListSessions.mockImplementation(() =>
      Promise.resolve([{ id: 'sess-1', name: 'other-session', cwd: '/tmp/ws' }])
    );

    try {
      await listEvents({ session: 'nonexistent' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).message).toContain('Session not found');
    }
  });
});

describe('events: no events directory', () => {
  beforeEach(() => {
    mockGetCurrentProject.mockImplementation(() => 'my-project');
    mockListSessions.mockImplementation(() =>
      Promise.resolve([{ id: 'sess-1', name: 'my-session', cwd: '/tmp/workspace' }])
    );
    mockListProcessEventsDirs.mockImplementation(() => []);
  });

  it('listEvents should throw SpacesError when no events dir found', async () => {
    try {
      await listEvents({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).message).toContain('No process events directory');
    }
  });
});

// ============================================================================
// showEvent specific validations
// ============================================================================

describe('showEvent', () => {
  it('should throw SpacesError when no eventId filter provided', async () => {
    try {
      await showEvent({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).message).toContain('eventId');
    }
  });

  it('should throw SpacesError when filter is not eventId-prefixed', async () => {
    try {
      await showEvent({ filter: 'level=error' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).exitCode).toBe(1);
      expect((err as SpacesError).message).toContain('eventId');
    }
  });
});

// ============================================================================
// Happy path with mocked events dir
// ============================================================================

describe('events: happy path', () => {
  let eventsDir = '';

  beforeEach(() => {
    eventsDir = makeTempEventsDir();
    mockGetCurrentProject.mockImplementation(() => 'my-project');
    mockListSessions.mockImplementation(() =>
      Promise.resolve([{ id: 'sess-1', name: 'my-session', cwd: '/tmp/workspace' }])
    );
    mockListProcessEventsDirs.mockImplementation(() => [eventsDir]);
    mockReadWideEvents.mockReset();
  });

  it('listEvents should succeed when events dir exists', async () => {
    mockReadWideEvents.mockImplementation(() => []);

    // Should not throw
    await listEvents({});
  });

  it('listEvents should output events as JSON', async () => {
    const fakeEvent = { eventId: 'evt-1', eventName: 'test', timestamp: Date.now() };
    mockReadWideEvents.mockImplementation(() => [fakeEvent]);

    // Should not throw
    await listEvents({});

    expect(mockReadWideEvents).toHaveBeenCalledTimes(1);
  });

  it('tailEvents should succeed when events dir exists', async () => {
    mockReadWideEvents.mockImplementation(() => []);

    await tailEvents({});
  });
});
