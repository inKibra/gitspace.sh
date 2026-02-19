/**
 * Events command tests - validates error paths throw SpacesError with exit code 1
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { SpacesError } from '../../types/errors.js';

// ============================================================================
// Mocks
// ============================================================================

// Mock config
const mockGetCurrentProject = mock<() => string | null>(() => null);
mock.module('../../core/config.js', () => ({
  getCurrentProject: mockGetCurrentProject,
  getGitspaceDir: mock(() => '/tmp/gitspace'),
}));

// Mock tmux-lite CLI
const mockListSessions = mock<() => Promise<Array<{ id: string; name: string; cwd: string }>>>(
  () => Promise.resolve([])
);
mock.module('../../lib/tmux-lite/cli.js', () => ({
  listSessions: mockListSessions,
}));

// Mock events paths
const mockGetProcessEventsDir = mock<(workspacePath: string, processName: string) => string>(
  () => '/tmp/events/processes/web-1'
);
const mockListProcessEventsDirs = mock<(workspacePath: string) => string[]>(() => []);
mock.module('../../lib/events/paths.js', () => ({
  getProcessEventsDir: mockGetProcessEventsDir,
  listProcessEventsDirs: mockListProcessEventsDirs,
}));

// Mock events reader
const mockReadWideEvents = mock<(...args: unknown[]) => unknown[]>(() => []);
mock.module('../../lib/events/reader.js', () => ({
  readWideEvents: mockReadWideEvents,
}));

// Mock fs.existsSync
const mockExistsSync = mock<(path: string) => boolean>(() => false);
mock.module('fs', () => ({
  existsSync: mockExistsSync,
  // Re-export defaults that other modules may need
  readFileSync: mock(() => ''),
  writeFileSync: mock(() => {}),
  mkdirSync: mock(() => {}),
  readdirSync: mock(() => []),
}));

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
      expect((err as SpacesError).message).toContain('Session not found');
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
    mockExistsSync.mockImplementation(() => false);
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
  beforeEach(() => {
    mockGetCurrentProject.mockImplementation(() => 'my-project');
    mockListSessions.mockImplementation(() =>
      Promise.resolve([{ id: 'sess-1', name: 'my-session', cwd: '/tmp/workspace' }])
    );
    mockListProcessEventsDirs.mockImplementation(() => ['/tmp/workspace/.events/processes/web-1']);
    mockExistsSync.mockImplementation(() => true);
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
