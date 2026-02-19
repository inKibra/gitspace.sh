/**
 * Wide event reader for CLI queries
 */

import { join } from 'path';
import { readFileSync } from 'fs';
import type { WideEvent, WideEventFilter, WideSnapshot, WideSnapshotTimelineEntry } from '../../types/events.js';
import { listEventIndexes, selectFilesForQuery, queryEvents } from './store.js';
import { listProcessEventsDirs } from './paths.js';

export interface WideEventQueryParams {
  eventsDir: string;
  filter: WideEventFilter;
  limit?: number;
  sinceMs?: number;
  untilMs?: number;
}

export function readWideEvents(params: WideEventQueryParams): WideEvent[] {
  const indexes = listEventIndexes(params.eventsDir);
  const selected = selectFilesForQuery(indexes, {
    filter: params.filter,
    limit: params.limit,
    sinceMs: params.sinceMs,
    untilMs: params.untilMs,
  });
  const sorted = [...selected].sort((a, b) => b.maxTs - a.maxTs);
  const results = queryEvents(
    params.eventsDir,
    sorted,
    {
      filter: params.filter,
      limit: params.limit,
      sinceMs: params.sinceMs,
      untilMs: params.untilMs,
    }
  );
  return results.reverse();

}

export function getEventsFilePath(eventsDir: string, indexFile: string): string {
  return join(eventsDir, indexFile);
}

type SnapshotCacheEntry = {
  snapshots: Map<string, WideSnapshot>;
  bytes: number;
  updatedAt: number;
};

const workspaceSnapshotCache = new Map<string, SnapshotCacheEntry>();
const DEFAULT_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 1000;
const DEFAULT_MAX_TIMELINE = 200;

function estimateSnapshotSize(snapshot: WideSnapshot): number {
  return Buffer.byteLength(JSON.stringify(snapshot));
}

function readSnapshotFile(filePath: string): WideSnapshot[] {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const snapshots: WideSnapshot[] = [];
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as WideSnapshot;
        if (!parsed || typeof parsed !== 'object') continue;
        if (typeof parsed.correlationId !== 'string') continue;
        if (typeof parsed.updatedAt !== 'number' || Number.isNaN(parsed.updatedAt)) continue;
        if (typeof parsed.eventName !== 'string') continue;
        if (typeof parsed.level !== 'string') continue;
        if (typeof parsed.message !== 'string') continue;
        if (typeof parsed.lastEventId !== 'string') continue;
        if (!parsed.timelineMap || typeof parsed.timelineMap !== 'object') continue;
        if (!Array.isArray(parsed.timelineOrder)) continue;
        if (!parsed.timelineOrder.every((entry) => typeof entry === 'string')) continue;
        snapshots.push(parsed);
      } catch {
        // Skip malformed snapshot entries
      }
    }
    return snapshots;
  } catch {
    return [];
  }
}

function mergeSnapshot(
  existing: WideSnapshot | undefined,
  incoming: WideSnapshot,
  maxTimeline: number
): WideSnapshot {
  if (!existing) {
    return incoming;
  }

  const orderedEntries: Array<{ entry: WideSnapshotTimelineEntry; seq: number }> = [];
  existing.timelineOrder.forEach((key, index) => {
    const entry = existing.timelineMap[key];
    if (entry) {
      orderedEntries.push({ entry, seq: index });
    }
  });
  const incomingOffset = orderedEntries.length;
  incoming.timelineOrder.forEach((key, index) => {
    const entry = incoming.timelineMap[key];
    if (entry) {
      orderedEntries.push({ entry, seq: incomingOffset + index });
    }
  });

  orderedEntries.sort((a, b) => {
    if (a.entry.timestampMs !== b.entry.timestampMs) {
      return a.entry.timestampMs - b.entry.timestampMs;
    }
    return a.seq - b.seq;
  });

  const maxEntries = Math.max(1, maxTimeline);
  const trimmedEntries =
    orderedEntries.length > maxEntries
      ? orderedEntries.slice(orderedEntries.length - maxEntries)
      : orderedEntries;

  const timelineMap: Record<string, WideSnapshotTimelineEntry> = {};
  const timelineOrder: string[] = [];
  const keyCounts = new Map<string, number>();
  for (const { entry } of trimmedEntries) {
    const baseName = entry.eventName;
    const count = keyCounts.get(baseName) ?? 0;
    const next = count + 1;
    keyCounts.set(baseName, next);
    const key = next === 1 ? baseName : `${baseName}#${next}`;
    timelineMap[key] = { ...entry, key };
    timelineOrder.push(key);
  }

  const isIncomingLatest = incoming.updatedAt >= existing.updatedAt;

  return {
    correlationId: incoming.correlationId,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
    processName: isIncomingLatest ? incoming.processName : existing.processName,
    processInstance: isIncomingLatest ? incoming.processInstance : existing.processInstance,
    level: isIncomingLatest ? incoming.level : existing.level,
    message: isIncomingLatest ? incoming.message : existing.message,
    eventName: isIncomingLatest ? incoming.eventName : existing.eventName,
    lastEventId: isIncomingLatest ? incoming.lastEventId : existing.lastEventId,
    timelineMap,
    timelineOrder,
    raw: isIncomingLatest ? incoming.raw : existing.raw,
  };
}

function applyCacheLimit(entry: SnapshotCacheEntry, maxBytes: number): void {
  if (entry.bytes <= maxBytes) return;
  const sorted = Array.from(entry.snapshots.values()).sort((a, b) => a.updatedAt - b.updatedAt);
  for (const snapshot of sorted) {
    if (entry.bytes <= maxBytes) break;
    entry.snapshots.delete(snapshot.correlationId);
    entry.bytes = Math.max(0, entry.bytes - estimateSnapshotSize(snapshot));
  }
}

export interface ReadWorkspaceSnapshotsOptions {
  maxBytes?: number;
  maxTimeline?: number;
  refresh?: boolean;
}

export function readWorkspaceSnapshots(
  workspacePath: string,
  options: ReadWorkspaceSnapshotsOptions = {}
): WideSnapshot[] {
  const cached = workspaceSnapshotCache.get(workspacePath);
  const isFresh = cached ? Date.now() - cached.updatedAt <= DEFAULT_CACHE_TTL_MS : false;
  if (cached && !options.refresh && isFresh) {
    return Array.from(cached.snapshots.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const maxBytes = options.maxBytes ?? DEFAULT_CACHE_BYTES;
  const maxTimeline = options.maxTimeline ?? DEFAULT_MAX_TIMELINE;

  const entry: SnapshotCacheEntry = {
    snapshots: new Map<string, WideSnapshot>(),
    bytes: 0,
    updatedAt: Date.now(),
  };

  const processDirs = listProcessEventsDirs(workspacePath);
  for (const dir of processDirs) {
    const filePath = join(dir, 'wide-snapshots.ndjson');
    const snapshots = readSnapshotFile(filePath);
    for (const snapshot of snapshots) {
      const existing = entry.snapshots.get(snapshot.correlationId);
      const merged = mergeSnapshot(existing, snapshot, maxTimeline);
      if (!existing) {
        entry.bytes += estimateSnapshotSize(merged);
      } else {
        entry.bytes = Math.max(0, entry.bytes - estimateSnapshotSize(existing));
        entry.bytes += estimateSnapshotSize(merged);
      }
      entry.snapshots.set(merged.correlationId, merged);
    }
  }

  applyCacheLimit(entry, maxBytes);
  workspaceSnapshotCache.set(workspacePath, entry);
  return Array.from(entry.snapshots.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}
