/**
 * Events command - query wide event logs
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { getProjectWorkspacesDir } from '../core/config.js';
import { getProcessEventsDir, listProcessEventsDirs } from '../lib/events/paths.js';
import { readWideEvents } from '../lib/events/reader.js';
import type { WideEventFilter } from '../types/events.js';

interface EventsCommandOptions {
  project?: string;
  workspace?: string;
  filter?: string;
  limit?: number;
}

interface EventsTailOptions extends EventsCommandOptions {
  follow?: boolean;
}

function parseFilter(filter?: string): WideEventFilter {
  if (!filter) return {};
  const separator = filter.indexOf('=');
  if (separator <= 0) return {};
  const key = filter.slice(0, separator);
  const value = filter.slice(separator + 1);
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
    case 'kind':
      return val === 'source' || val === 'wide' ? { kind: val } : {};
    case 'correlationId':
      return { correlationId: val };
    default:
      return {};
  }
}

async function resolveEventsDir(options: EventsCommandOptions): Promise<string> {
  if (!options.project) {
    throw new SpacesError('Provide project via --project <name>.', 'USER_ERROR');
  }

  if (!options.workspace) {
    throw new SpacesError('Provide workspace via --workspace <name>.', 'USER_ERROR');
  }

  const workspacePath = join(getProjectWorkspacesDir(options.project), options.workspace);
  if (!existsSync(workspacePath)) {
    throw new SpacesError(
      `Workspace not found: ${options.project}/${options.workspace}`,
      'USER_ERROR'
    );
  }

  const processName = parseFilter(options.filter).processName;
  const eventsDir = processName
    ? getProcessEventsDir(workspacePath, processName)
    : listProcessEventsDirs(workspacePath)[0];

  if (!eventsDir || !existsSync(eventsDir)) {
    throw new SpacesError('No process events directory found for this workspace.', 'USER_ERROR');
  }

  return eventsDir;
}

export async function listEvents(options: EventsCommandOptions): Promise<void> {
  const eventsDir = await resolveEventsDir(options);

  const filter = parseFilter(options.filter);
  const events = readWideEvents({
    eventsDir,
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

  const eventsDir = await resolveEventsDir(options);

  const filter = parseFilter(options.filter);
  const events = readWideEvents({
    eventsDir,
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
  const eventsDir = await resolveEventsDir(options);

  const filter = parseFilter(options.filter);
  const events = readWideEvents({
    eventsDir,
    filter,
    limit: options.limit ?? 50,
  });

  for (const event of events) {
    logger.log(JSON.stringify(event));
  }

  if (!options.follow) return;

  logger.info('Follow mode not implemented yet.');
}
