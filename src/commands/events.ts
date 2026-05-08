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
import type { WideEvent, WideEventFilter } from '../types/events.js';

export interface EventsCommandOptions {
  project?: string;
  workspace?: string;
  filter?: string | string[];
  process?: string;
  processName?: string;
  level?: string;
  event?: string;
  eventName?: string;
  eventId?: string;
  correlationId?: string;
  since?: string;
  until?: string;
  limit?: number;
  head?: number | boolean;
  tail?: number | boolean;
  order?: 'asc' | 'desc';
}

export interface EventsTailOptions extends EventsCommandOptions {
  follow?: boolean;
}

interface EventQuery {
  filter: WideEventFilter;
  limit?: number;
  sinceMs?: number;
  untilMs?: number;
  order: 'asc' | 'desc';
}

function parseFilterExpression(filter: string): WideEventFilter {
  const separator = filter.indexOf('=');
  if (separator <= 0) return {};
  const key = filter.slice(0, separator).trim();
  const val = filter.slice(separator + 1).trim();
  switch (key) {
    case 'event':
    case 'eventName':
      return { eventName: val };
    case 'eventId':
      return { eventId: val };
    case 'level':
      return { level: val };
    case 'message':
      return { message: val };
    case 'process':
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

function mergeFilter(left: WideEventFilter, right: WideEventFilter): WideEventFilter {
  return { ...left, ...right };
}

function parseFilter(options: EventsCommandOptions): WideEventFilter {
  const filters = Array.isArray(options.filter)
    ? options.filter
    : options.filter
      ? [options.filter]
      : [];

  let parsed: WideEventFilter = {};
  for (const filter of filters) {
    parsed = mergeFilter(parsed, parseFilterExpression(filter));
  }

  return mergeFilter(parsed, {
    processName: options.process ?? options.processName ?? parsed.processName,
    level: options.level ?? parsed.level,
    eventName: options.event ?? options.eventName ?? parsed.eventName,
    eventId: options.eventId ?? parsed.eventId,
    correlationId: options.correlationId ?? parsed.correlationId,
  });
}

function parseTimeBoundary(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const duration = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2];
    const multiplier = unit === 'ms'
      ? 1
      : unit === 's'
        ? 1000
        : unit === 'm'
          ? 60_000
          : unit === 'h'
            ? 3_600_000
            : 86_400_000;
    return now - amount * multiplier;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new SpacesError(`Invalid time boundary '${value}'. Use a duration like 30m or an ISO timestamp.`, 'USER_ERROR');
  }
  return parsed;
}

function numberOption(value: number | boolean | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function buildQuery(options: EventsCommandOptions, defaultLimit: number): EventQuery {
  const head = numberOption(options.head);
  const tail = numberOption(options.tail);
  const requestedOrder = options.order;
  if (requestedOrder !== undefined && requestedOrder !== 'asc' && requestedOrder !== 'desc') {
    throw new SpacesError("Invalid --order value. Use 'asc' or 'desc'.", 'USER_ERROR');
  }
  const order = requestedOrder ?? (head !== undefined ? 'asc' : 'desc');
  const limit = head ?? tail ?? options.limit ?? defaultLimit;
  return {
    filter: parseFilter(options),
    limit,
    sinceMs: parseTimeBoundary(options.since),
    untilMs: parseTimeBoundary(options.until),
    order,
  };
}

async function resolveEventsDirs(options: EventsCommandOptions, filter: WideEventFilter): Promise<string[]> {
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

  const processName = filter.processName;
  const eventsDirs = processName
    ? [getProcessEventsDir(workspacePath, processName)]
    : listProcessEventsDirs(workspacePath);

  const existingDirs = eventsDirs.filter((eventsDir) => existsSync(eventsDir));

  if (existingDirs.length === 0) {
    throw new SpacesError('No process events directory found for this workspace.', 'USER_ERROR');
  }

  return existingDirs;
}

function getEventTimestamp(event: WideEvent): number {
  if (typeof event.timestampMs === 'number' && !Number.isNaN(event.timestampMs)) {
    return event.timestampMs;
  }
  const parsed = Date.parse(event.timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function readWideEventsFromDirs(eventsDirs: string[], query: EventQuery): WideEvent[] {
  if (eventsDirs.length === 1) {
    return readWideEvents({
      eventsDir: eventsDirs[0],
      filter: query.filter,
      limit: query.limit,
      sinceMs: query.sinceMs,
      untilMs: query.untilMs,
      order: query.order,
    });
  }

  const merged = eventsDirs.flatMap((eventsDir) =>
    readWideEvents({
      eventsDir,
      filter: query.filter,
      sinceMs: query.sinceMs,
      untilMs: query.untilMs,
      order: query.order,
    })
  );

  const sorted = [...merged].sort((a, b) => query.order === 'asc'
    ? getEventTimestamp(a) - getEventTimestamp(b)
    : getEventTimestamp(b) - getEventTimestamp(a));
  const limited = typeof query.limit === 'number' ? sorted.slice(0, query.limit) : sorted;
  return query.order === 'asc' ? limited : limited.reverse();
}

function printEvents(events: WideEvent[]): void {
  for (const event of events) {
    logger.log(JSON.stringify(event));
  }
}

export async function listEvents(options: EventsCommandOptions): Promise<void> {
  const query = buildQuery(options, 100);
  const eventsDirs = await resolveEventsDirs(options, query.filter);
  const events = readWideEventsFromDirs(eventsDirs, query);

  if (events.length === 0) {
    logger.info('No events found.');
    return;
  }

  printEvents(events);
}

export async function showEvent(options: EventsCommandOptions): Promise<void> {
  const query = buildQuery(options, 1);
  if (!query.filter.eventId) {
    throw new SpacesError('Provide event id via --event-id <id> or --filter "eventId=<id>"', 'USER_ERROR');
  }

  const eventsDirs = await resolveEventsDirs(options, query.filter);
  const events = readWideEventsFromDirs(eventsDirs, { ...query, limit: 1 });

  if (events.length === 0) {
    logger.info('No event found.');
    return;
  }

  logger.log(JSON.stringify(events[0], null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function tailEvents(options: EventsTailOptions): Promise<void> {
  const query = buildQuery(options, 50);
  const eventsDirs = await resolveEventsDirs(options, query.filter);
  const events = readWideEventsFromDirs(eventsDirs, query);
  const seenEventIds = new Set(events.map((event) => event.eventId));

  printEvents(events);

  if (!options.follow) return;

  while (true) {
    await sleep(1000);
    const nextQuery: EventQuery = {
      ...query,
      sinceMs: Date.now() - 5 * 60_000,
      order: 'asc',
    };
    const nextEvents = readWideEventsFromDirs(eventsDirs, nextQuery).filter((event) => !seenEventIds.has(event.eventId));
    for (const event of nextEvents) {
      seenEventIds.add(event.eventId);
    }
    printEvents(nextEvents);
  }
}
