/**
 * Events command - query wide event logs
 */

import { existsSync } from 'fs';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { getCurrentProject } from '../core/config.js';
import { listSessions } from '../lib/tmux-lite/cli.js';
import { getProcessEventsDir, listProcessEventsDirs } from '../lib/events/paths.js';
import { readWideEvents } from '../lib/events/reader.js';
import type { WideEventFilter } from '../types/events.js';

interface EventsCommandOptions {
  session?: string;
  workspace?: string;
  filter?: string;
  limit?: number;
}

interface EventsTailOptions extends EventsCommandOptions {
  follow?: boolean;
}

function parseFilter(filter?: string): WideEventFilter {
  if (!filter) return {};
  const [key, value] = filter.split('=');
  if (!key || value === undefined) return {};
  const trimmed = key.trim();
  const val = value.trim();
  switch (trimmed) {
    case 'eventName':
      return { eventName: val };
    case 'eventId':
      return { eventId: val };
    case 'level':
      return { level: val };
    case 'message':
      return { message: val };
    case 'processName':
      return { processName: val };
    default:
      return {};
  }
}

async function resolveEventsDir(options: EventsCommandOptions): Promise<{ eventsDir: string; sessionId: string }> {
  const project = getCurrentProject();
  if (!project) {
    throw new SpacesError('No current project. Run `gssh switch project` first.', 'USER_ERROR');
  }

  const sessions = await listSessions();
  const target = options.session
    ? sessions.find((s) => s.id === options.session || s.name === options.session)
    : sessions[0];

  if (!target) {
    throw new SpacesError('Session not found.', 'USER_ERROR');
  }

  const workspacePath = target.cwd;
  const workspaceId = workspacePath.split('/').pop() || 'workspace';

  const processName = options.filter?.startsWith('processName=')
    ? options.filter.split('=')[1]
    : undefined;
  const eventsDir = processName
    ? getProcessEventsDir(workspacePath, processName)
    : listProcessEventsDirs(workspacePath)[0];

  if (!eventsDir || !existsSync(eventsDir)) {
    throw new SpacesError('No process events directory found for this workspace.', 'USER_ERROR');
  }

  return { eventsDir, sessionId: workspaceId };
}

export async function listEvents(options: EventsCommandOptions): Promise<void> {
  const resolved = await resolveEventsDir(options);

  const filter = parseFilter(options.filter);
  const events = readWideEvents({
    eventsDir: resolved.eventsDir,
    filter,
    limit: options.limit,
  });

  if (events.length === 0) {
    logger.info('No events found.');
    return;
  }

  for (const event of events) {
    logger.log(JSON.stringify(event));
  }
}

export async function showEvent(options: EventsCommandOptions): Promise<void> {
  if (!options.filter || !options.filter.startsWith('eventId=')) {
    throw new SpacesError('Provide eventId filter: --filter "eventId=<id>"', 'USER_ERROR');
  }

  const resolved = await resolveEventsDir(options);

  const filter = parseFilter(options.filter);
  const events = readWideEvents({
    eventsDir: resolved.eventsDir,
    filter,
    limit: 1,
  });

  if (events.length === 0) {
    logger.info('No event found.');
    return;
  }

  logger.log(JSON.stringify(events[0], null, 2));
}

export async function tailEvents(options: EventsTailOptions): Promise<void> {
  const resolved = await resolveEventsDir(options);

  const filter = parseFilter(options.filter);
  const events = readWideEvents({
    eventsDir: resolved.eventsDir,
    filter,
    limit: options.limit ?? 50,
  });

  for (const event of events) {
    logger.log(JSON.stringify(event));
  }

  if (!options.follow) return;

  logger.info('Follow mode not implemented yet.');
}
