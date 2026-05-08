/**
 * Events command tests
 */

import { describe, expect, it, mock, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as realConfig from '../../core/config.js';
import * as realEventPaths from '../../lib/events/paths.js';
import * as realEventReader from '../../lib/events/reader.js';
import { SpacesError } from '../../types/errors.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

let baseDir = makeTempDir('gssh-events-base-');

const mockGetProjectWorkspacesDir = mock<(projectName: string) => string>((projectName: string) =>
  join(baseDir, projectName, 'workspaces')
);

mock.module('../../core/config.js', () => ({
  ...realConfig,
  getProjectWorkspacesDir: mockGetProjectWorkspacesDir,
}));

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

const mockReadWideEvents = mock<(...args: unknown[]) => unknown[]>((...args: unknown[]) =>
  realEventReader.readWideEvents(...(args as Parameters<typeof realEventReader.readWideEvents>))
);

mock.module('../../lib/events/reader.js', () => ({
  ...realEventReader,
  readWideEvents: mockReadWideEvents,
}));

const { listEvents, showEvent, tailEvents } = await import('../events.js');

function makeWorkspace(projectName: string, workspaceName: string): string {
  const workspacePath = join(mockGetProjectWorkspacesDir(projectName), workspaceName);
  mkdirSync(workspacePath, { recursive: true });
  return workspacePath;
}

afterAll(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

beforeEach(() => {
  baseDir = makeTempDir('gssh-events-base-');
  mockGetProcessEventsDir.mockReset();
  mockListProcessEventsDirs.mockReset();
  mockReadWideEvents.mockReset();
  mockGetProjectWorkspacesDir.mockImplementation((projectName: string) =>
    join(baseDir, projectName, 'workspaces')
  );
  mockListProcessEventsDirs.mockImplementation(() => []);
  mockReadWideEvents.mockImplementation(() => []);
});

describe('events command requires explicit project/workspace', () => {
  it('throws when --project is missing', async () => {
    try {
      await listEvents({ workspace: 'ws-1' });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).message).toContain('Provide project');
    }
  });

  it('throws when --workspace is missing', async () => {
    try {
      await listEvents({ project: 'my-project' });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).message).toContain('Provide workspace');
    }
  });

  it('throws when explicit workspace does not exist', async () => {
    try {
      await listEvents({ project: 'my-project', workspace: 'missing-ws' });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).message).toContain('Workspace not found');
    }
  });
});

describe('events command directory resolution', () => {
  it('throws when no process events directory exists', async () => {
    makeWorkspace('my-project', 'ws-1');
    mockListProcessEventsDirs.mockImplementation(() => []);

    try {
      await listEvents({ project: 'my-project', workspace: 'ws-1' });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).message).toContain('No process events directory');
    }
  });

  it('uses processName filter to resolve process-specific events dir', async () => {
    const workspacePath = makeWorkspace('my-project', 'ws-1');
    const eventsDir = makeTempDir('gssh-events-dir-');
    mockGetProcessEventsDir.mockImplementation(() => eventsDir);

    await listEvents({
      project: 'my-project',
      workspace: 'ws-1',
      filter: 'processName=web',
    });

    expect(mockGetProcessEventsDir).toHaveBeenCalledWith(workspacePath, 'web');
  });

  it('aggregates events across all process dirs when processName is not provided', async () => {
    makeWorkspace('my-project', 'ws-1');
    const eventsDirA = makeTempDir('gssh-events-dir-a-');
    const eventsDirB = makeTempDir('gssh-events-dir-b-');
    mockListProcessEventsDirs.mockImplementation(() => [eventsDirA, eventsDirB]);

    await listEvents({ project: 'my-project', workspace: 'ws-1' });

    expect(mockReadWideEvents).toHaveBeenCalledTimes(2);
    expect(mockReadWideEvents).toHaveBeenCalledWith(expect.objectContaining({ eventsDir: eventsDirA, filter: {} }));
    expect(mockReadWideEvents).toHaveBeenCalledWith(expect.objectContaining({ eventsDir: eventsDirB, filter: {} }));
  });

  it('combines repeatable and alias filters', async () => {
    makeWorkspace('my-project', 'ws-1');
    const eventsDir = makeTempDir('gssh-events-dir-');
    mockGetProcessEventsDir.mockImplementation(() => eventsDir);

    await listEvents({
      project: 'my-project',
      workspace: 'ws-1',
      filter: ['level=warn', 'correlationId=req-1'],
      process: 'web',
      event: 'process.ready',
      limit: 25,
    });

    expect(mockReadWideEvents).toHaveBeenCalledWith(expect.objectContaining({
      eventsDir,
      filter: {
        level: 'warn',
        correlationId: 'req-1',
        processName: 'web',
        eventName: 'process.ready',
      },
      limit: 25,
    }));
  });

  it('passes since and head options through as ascending query', async () => {
    makeWorkspace('my-project', 'ws-1');
    const eventsDir = makeTempDir('gssh-events-dir-');
    mockListProcessEventsDirs.mockImplementation(() => [eventsDir]);

    await listEvents({
      project: 'my-project',
      workspace: 'ws-1',
      since: '30m',
      head: 20,
    });

    const call = mockReadWideEvents.mock.calls[0]?.[0] as { sinceMs?: number; order?: string; limit?: number };
    expect(call.limit).toBe(20);
    expect(call.order).toBe('asc');
    expect(typeof call.sinceMs).toBe('number');
  });
});

describe('showEvent validations', () => {
  it('throws when eventId filter is missing', async () => {
    try {
      await showEvent({ project: 'my-project', workspace: 'ws-1' });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).message).toContain('eventId');
    }
  });

  it('throws when filter is not eventId-prefixed', async () => {
    try {
      await showEvent({ project: 'my-project', workspace: 'ws-1', filter: 'level=error' });
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SpacesError);
      expect((err as SpacesError).message).toContain('eventId');
    }
  });
});

  it('accepts --event-id alias', async () => {
    makeWorkspace('my-project', 'ws-1');
    const eventsDir = makeTempDir('gssh-events-dir-');
    mockListProcessEventsDirs.mockImplementation(() => [eventsDir]);
    mockReadWideEvents.mockImplementation(() => []);

    await showEvent({ project: 'my-project', workspace: 'ws-1', eventId: 'evt-1' });

    expect(mockReadWideEvents).toHaveBeenCalledWith(expect.objectContaining({
      filter: { eventId: 'evt-1' },
      limit: 1,
    }));
  });

describe('events command happy path', () => {
  it('listEvents succeeds when events dir exists', async () => {
    makeWorkspace('my-project', 'ws-1');
    const eventsDir = makeTempDir('gssh-events-dir-');
    mockListProcessEventsDirs.mockImplementation(() => [eventsDir]);
    mockReadWideEvents.mockImplementation(() => []);

    await listEvents({ project: 'my-project', workspace: 'ws-1' });
    expect(mockReadWideEvents).toHaveBeenCalledTimes(1);
  });

  it('tailEvents succeeds when events dir exists', async () => {
    makeWorkspace('my-project', 'ws-1');
    const eventsDir = makeTempDir('gssh-events-dir-');
    mockListProcessEventsDirs.mockImplementation(() => [eventsDir]);
    mockReadWideEvents.mockImplementation(() => []);

    await tailEvents({ project: 'my-project', workspace: 'ws-1' });
    expect(mockReadWideEvents).toHaveBeenCalledTimes(1);
  });
});
