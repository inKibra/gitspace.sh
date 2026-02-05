/**
 * Wide event storage and query helpers
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { WideEvent, WideEventFilter, WideEventIndex } from '../../types/events.js';

export interface WideEventQueryOptions {
  filter: WideEventFilter;
  limit?: number;
  sinceMs?: number;
  untilMs?: number;
}

export function listEventIndexes(eventsDir: string): WideEventIndex[] {
  if (!existsSync(eventsDir)) {
    return [];
  }
  return readdirSync(eventsDir)
    .filter((file) => file.endsWith('.index.json'))
    .map((file) => {
      const path = join(eventsDir, file);
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8')) as WideEventIndex;
        return data;
      } catch {
        return null;
      }
    })
    .filter((item): item is WideEventIndex => Boolean(item));
}

export function selectFilesForQuery(indexes: WideEventIndex[], options: WideEventQueryOptions): WideEventIndex[] {
  return indexes.filter((index) => {
    if (options.sinceMs !== undefined && index.maxTs < options.sinceMs) {
      return false;
    }
    if (options.untilMs !== undefined && index.minTs > options.untilMs) {
      return false;
    }
    if (options.filter.level && !index.levels.includes(options.filter.level)) {
      return false;
    }
    if (options.filter.eventName && !index.eventNames.includes(options.filter.eventName)) {
      return false;
    }
    return true;
  });
}

export function queryEvents(
  eventsDir: string,
  indexes: WideEventIndex[],
  options: WideEventQueryOptions
): WideEvent[] {
  const results: WideEvent[] = [];
  const limit = options.limit ?? 100;

  for (const index of indexes) {
    const path = join(eventsDir, index.file);
    if (!existsSync(path)) continue;

    const lines = readFileSync(path, 'utf-8').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line || !line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const event = normalizeStoredEvent(raw);
        if (!event) continue;
        if (!matchesQuery(event, options)) continue;
        results.push(event);
        if (results.length >= limit) {
          return results;
        }
      } catch {
        // Ignore malformed lines
      }
    }
  }

  return results;
}

function normalizeStoredEvent(raw: Record<string, unknown>): WideEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const eventId = typeof raw.eventId === 'string' ? raw.eventId : null;
  const eventName = typeof raw.eventName === 'string' ? raw.eventName : null;
  const level = typeof raw.level === 'string' ? raw.level : null;
  const timestamp = typeof raw.timestamp === 'string' ? raw.timestamp : null;
  const message = typeof raw.message === 'string' ? raw.message : null;
  const timestampMs = typeof raw.timestampMs === 'number' ? raw.timestampMs : Date.parse(timestamp ?? '');
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId : '';
  const workspaceId = typeof raw.workspaceId === 'string' ? raw.workspaceId : '';
  const projectName = typeof raw.projectName === 'string' ? raw.projectName : '';
  const processName = typeof raw.processName === 'string' ? raw.processName : undefined;
  const processInstance = typeof raw.processInstance === 'number' ? raw.processInstance : undefined;
  const kind = raw.kind === 'wide' || raw.kind === 'source' ? raw.kind : undefined;
  const correlationId = typeof raw.correlationId === 'string' ? raw.correlationId : undefined;
  const timeline = Array.isArray(raw.timeline)
    ? (raw.timeline as WideEvent['timeline'])
    : undefined;

  if (!eventId || !eventName || !level || !timestamp || !message || Number.isNaN(timestampMs)) {
    return null;
  }

  return {
    eventId,
    eventName,
    level,
    timestamp,
    timestampMs,
    message,
    sessionId,
    workspaceId,
    projectName,
    processName,
    processInstance,
    raw,
    kind,
    correlationId,
    timeline,
  };

}

function matchesQuery(event: WideEvent, options: WideEventQueryOptions): boolean {
  const { filter, sinceMs, untilMs } = options;
  if (filter.eventName && event.eventName !== filter.eventName) return false;
  if (filter.eventId && event.eventId !== filter.eventId) return false;
  if (filter.level && event.level !== filter.level) return false;
  if (filter.message && !event.message.includes(filter.message)) return false;
  if (filter.processName && event.processName !== filter.processName) return false;
  if (filter.kind && event.kind !== filter.kind) return false;
  if (filter.correlationId && event.correlationId !== filter.correlationId) return false;
  if (sinceMs !== undefined && event.timestampMs < sinceMs) return false;
  if (untilMs !== undefined && event.timestampMs > untilMs) return false;
  return true;
}
