/**
 * Wide event collector for tmux-lite output
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { EventsConfig } from '../../types/config.js';
import type { WideEvent, WideEventFilter, WideEventIndex, WideEventTimelineItem, WideSnapshot, WideSnapshotTimelineEntry, WideSnapshotTimelineMap } from '../../types/events.js';
import { getProcessEventsDir, getProcessSnapshotsPath } from './paths.js';
import { writeIndexFile } from './indexer.js';

const LINE_BUFFER_LIMIT = 1_000_000; // 1MB safety cap

interface EventFileState {
  filePath: string;
  indexPath: string;
  createdAt: number;
  bytesWritten: number;
  index: WideEventIndex;
}

export interface WideEventCollectorOptions {
  config: EventsConfig;
  sessionId: string;
  workspacePath: string;
  workspaceId: string;
  projectName: string;
  processName?: string;
  processInstance?: number;
}

export class WideEventCollector {
  private config: EventsConfig;
  private sessionId: string;
  private workspacePath: string;
  private workspaceId: string;
  private projectName: string;
  private processName?: string;
  private processInstance?: number;
  private buffer = '';
  private fileState: EventFileState | null = null;
  private liveEvents = new Map<string, number>();
  private correlationTimeline = new Map<string, WideEventTimelineItem[]>();
  private lastWideEmitAt = new Map<string, number>();
  private snapshotCache = new Map<string, WideSnapshot>();
  private snapshotCacheBytes = 0;
  private snapshotsLoaded = false;

  constructor(options: WideEventCollectorOptions) {
    this.config = options.config;
    this.sessionId = options.sessionId;
    this.workspacePath = options.workspacePath;
    this.workspaceId = options.workspaceId;
    this.projectName = options.projectName;
    this.processName = options.processName;
    this.processInstance = options.processInstance;
  }

  handleChunk(data: Buffer): WideEvent[] {
    if (!this.config.enabled) {
      return [];
    }
    const chunk = data.toString('utf-8');
    if (!chunk) {
      return [];
    }

    this.buffer += chunk;
    if (this.buffer.length > LINE_BUFFER_LIMIT) {
      this.buffer = this.buffer.slice(-LINE_BUFFER_LIMIT);
    }

    const events: WideEvent[] = [];
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        const event = this.tryParseEvent(line);
        if (event) {
          const emitted = this.appendEvent(event);
          events.push(...emitted);
        }
      }
      newlineIndex = this.buffer.indexOf('\n');
    }

    return events;
  }

  finalize(): void {
    if (this.fileState) {
      this.flushIndex(this.fileState);
    }
  }

  getLiveEventIds(ttlMs: number): string[] {
    const now = Date.now();
    const live: string[] = [];
    for (const [eventId, lastSeen] of this.liveEvents.entries()) {
      if (now - lastSeen <= ttlMs) {
        live.push(eventId);
      }
    }
    return live;
  }

  private tryParseEvent(line: string): WideEvent | null {
    const { mode, prefix } = this.config;
    let payload = line;

    if (mode === 'prefix') {
      if (!payload.startsWith(prefix)) {
        return null;
      }
      payload = payload.slice(prefix.length).trim();
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const fields = this.config.fields;
    const eventName = parsed[fields.name];
    const eventId = parsed[fields.id];
    const level = parsed[fields.level];
    const timestamp = parsed[fields.timestamp];
    const message = parsed[fields.message];

    if (
      typeof eventName !== 'string' ||
      typeof eventId !== 'string' ||
      typeof level !== 'string' ||
      typeof timestamp !== 'string' ||
      typeof message !== 'string'
    ) {
      return null;
    }

    const timestampMs = Date.parse(timestamp);
    const normalizedTimestampMs = Number.isNaN(timestampMs) ? Date.now() : timestampMs;

    if (this.config.aggregateMode === 'stream' && this.config.correlationField) {
      const rawCorrelation = parsed[this.config.correlationField];
      if (typeof rawCorrelation === 'string') {
        parsed[this.config.correlationField] = rawCorrelation.trim();
      }
    }

    return {
      eventId,
      eventName,
      level,
      timestamp,
      timestampMs: normalizedTimestampMs,
      message,
      sessionId: '',
      workspaceId: this.workspaceId,
      projectName: this.projectName,
      processName: this.processName,
      processInstance: this.processInstance,
      raw: parsed,
      kind: 'source',
    };
  }

  private appendEvent(event: WideEvent): WideEvent[] {
    const emitted: WideEvent[] = [];
    const sourceEvent = { ...event, kind: 'source' as const };
    this.writeEvent(sourceEvent);
    emitted.push(sourceEvent);

    if (this.config.aggregateMode === 'stream') {
      const correlationField = this.config.correlationField;
      const correlationId = correlationField ? (event.raw[correlationField] as string | undefined) : undefined;
      if (correlationId && correlationId.trim().length > 0) {
        const timeline = this.correlationTimeline.get(correlationId) ?? [];
        const timelineItem: WideEventTimelineItem = {
          eventName: event.eventName,
          level: event.level,
          timestamp: event.timestamp,
          timestampMs: event.timestampMs,
          message: event.message,
          raw: event.raw,
        };
        timeline.push(timelineItem);
        const maxTimeline = this.config.maxTimeline ?? 200;
        if (timeline.length > maxTimeline) {
          timeline.splice(0, timeline.length - maxTimeline);
        }
        this.correlationTimeline.set(correlationId, timeline);

        const now = Date.now();
        const lastEmit = this.lastWideEmitAt.get(correlationId) ?? 0;
        const interval = this.config.updateIntervalMs ?? 250;
        if (now - lastEmit >= interval) {
          const wideEvent: WideEvent = {
            ...event,
            kind: 'wide',
            correlationId,
            timeline: [...timeline],
          };
          this.writeEvent(wideEvent);
          emitted.push(wideEvent);
          this.lastWideEmitAt.set(correlationId, now);
        }

        const snapshot = this.updateSnapshot(correlationId, event);
        if (snapshot) {
          this.writeSnapshot(snapshot);
        }
      }
    }

    return emitted;
  }

  private writeEvent(event: WideEvent): void {
    const state = this.ensureFileState();
    const line = JSON.stringify(event) + '\n';
    appendFileSync(state.filePath, line, 'utf-8');
    state.bytesWritten += Buffer.byteLength(line);

    state.index.count += 1;
    state.index.minTs = Math.min(state.index.minTs, event.timestampMs);
    state.index.maxTs = Math.max(state.index.maxTs, event.timestampMs);
    if (!state.index.levels.includes(event.level)) {
      state.index.levels.push(event.level);
    }
    if (!state.index.eventNames.includes(event.eventName)) {
      state.index.eventNames.push(event.eventName);
    }

    this.liveEvents.set(event.eventId, Date.now());
    this.flushIndex(state);

    if (this.shouldRotate(state)) {
      this.rotate(state);
    }
  }

  private ensureFileState(): EventFileState {
    if (this.fileState) {
      return this.fileState;
    }

    const dir = getProcessEventsDir(
      this.workspacePath,
      this.processName ?? 'unknown',
      this.processInstance
    );
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace(/:/g, '-');
    const fileName = `events-${stamp}.ndjson`;
    const filePath = join(dir, fileName);
    const indexPath = join(dir, `events-${stamp}.index.json`);

    const state: EventFileState = {
      filePath,
      indexPath,
      createdAt: Date.now(),
      bytesWritten: 0,
      index: {
        file: fileName,
        minTs: Number.POSITIVE_INFINITY,
        maxTs: 0,
        levels: [],
        eventNames: [],
        count: 0,
      },
    };

    this.fileState = state;
    return state;
  }

  private shouldRotate(state: EventFileState): boolean {
    if (state.bytesWritten >= this.config.rotation.maxBytes) {
      return true;
    }
    const ageMinutes = (Date.now() - state.createdAt) / (1000 * 60);
    return ageMinutes >= this.config.rotation.maxMinutes;
  }

  private rotate(state: EventFileState): void {
    this.flushIndex(state);
    this.fileState = null;
    this.pruneOldFiles();
  }

  private flushIndex(state: EventFileState): void {
    if (state.index.count === 0) {
      return;
    }
    writeIndexFile(state.indexPath, state.index);
  }

  private pruneOldFiles(): void {
    const dir = getProcessEventsDir(
      this.workspacePath,
      this.processName ?? 'unknown',
      this.processInstance
    );
    if (!existsSync(dir)) {
      return;
    }

    const files = readdirSync(dir)
      .filter((file) => file.endsWith('.ndjson') && !file.endsWith('wide-snapshots.ndjson'))
      .map((file) => ({
        file,
        path: join(dir, file),
        mtime: statSync(join(dir, file)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length <= this.config.rotation.keepFiles) {
      return;
    }

    const toRemove = files.slice(this.config.rotation.keepFiles);
    for (const entry of toRemove) {
      try {
        unlinkSync(entry.path);
        const indexPath = entry.path.replace('.ndjson', '.index.json');
        if (existsSync(indexPath)) {
          unlinkSync(indexPath);
        }
      } catch {
        // Ignore rotation errors
      }
    }
  }

  private updateSnapshot(correlationId: string, event: WideEvent): WideSnapshot | null {
    if (!correlationId) return null;
    this.ensureSnapshotsLoaded();
    const existing = this.snapshotCache.get(correlationId);
    const timelineMap: WideSnapshotTimelineMap = existing?.timelineMap ? { ...existing.timelineMap } : {};
    const timelineOrder = existing?.timelineOrder ? [...existing.timelineOrder] : [];
    const maxTimeline = Math.max(1, this.config.maxTimeline ?? 200);
    if (timelineOrder.length >= maxTimeline) {
      const overflow = Math.max(0, timelineOrder.length - (maxTimeline - 1));
      if (overflow > 0) {
        const removed = timelineOrder.splice(0, overflow);
        for (const key of removed) {
          delete timelineMap[key];
        }
      }
    }
    const counts = new Map<string, number>();
    for (const entry of Object.values(timelineMap)) {
      if (!entry) continue;
      const baseName = entry.eventName;
      counts.set(baseName, (counts.get(baseName) ?? 0) + 1);
    }

    const baseName = event.eventName;
    const currentCount = counts.get(baseName) ?? 0;
    const nextCount = currentCount + 1;
    counts.set(baseName, nextCount);
    const key = nextCount === 1 ? baseName : `${baseName}#${nextCount}`;

    const entry: WideSnapshotTimelineEntry = {
      key,
      eventId: event.eventId,
      eventName: event.eventName,
      level: event.level,
      timestamp: event.timestamp,
      timestampMs: event.timestampMs,
      message: event.message,
      raw: event.raw,
      processName: event.processName,
      processInstance: event.processInstance,
    };

    timelineMap[key] = entry;
    timelineOrder.push(key);

    const snapshot: WideSnapshot = {
      correlationId,
      updatedAt: Date.now(),
      processName: this.processName,
      processInstance: this.processInstance,
      level: event.level,
      message: event.message,
      eventName: event.eventName,
      lastEventId: event.eventId,
      timelineMap,
      timelineOrder,
      raw: event.raw,
    };

    this.setSnapshotCache(snapshot);
    this.evictSnapshots();
    return snapshot;
  }

  private setSnapshotCache(snapshot: WideSnapshot): void {
    const existing = this.snapshotCache.get(snapshot.correlationId);
    const existingSize = existing ? Buffer.byteLength(JSON.stringify(existing)) : 0;
    const snapshotSize = Buffer.byteLength(JSON.stringify(snapshot));
    this.snapshotCache.set(snapshot.correlationId, snapshot);
    this.snapshotCacheBytes = Math.max(0, this.snapshotCacheBytes - existingSize) + snapshotSize;
  }

  private ensureSnapshotsLoaded(): void {
    if (this.snapshotsLoaded) return;
    this.snapshotsLoaded = true;
    const path = getProcessSnapshotsPath(
      this.workspacePath,
      this.processName ?? 'unknown',
      this.processInstance
    );
    if (!existsSync(path)) {
      return;
    }
    try {
      const content = readFileSync(path, 'utf-8');
      for (const line of content.split('\n')) {
        if (line.trim().length === 0) continue;
        try {
          const parsed = JSON.parse(line) as WideSnapshot;
          if (!parsed || typeof parsed !== 'object') continue;
          if (typeof parsed.correlationId !== 'string') continue;
          const existing = this.snapshotCache.get(parsed.correlationId);
          if (existing && existing.updatedAt > parsed.updatedAt) {
            continue;
          }
          this.setSnapshotCache(parsed);
        } catch {
          // Ignore malformed snapshot lines
        }
      }
      this.evictSnapshots();
    } catch {
      // Ignore snapshot load errors
    }
  }

  private evictSnapshots(): void {
    const maxBytes = this.config.snapshotCacheMaxBytes ?? 64 * 1024 * 1024;
    if (this.snapshotCacheBytes <= maxBytes) return;
    const entries = Array.from(this.snapshotCache.values()).sort((a, b) => a.updatedAt - b.updatedAt);
    for (const entry of entries) {
      if (this.snapshotCacheBytes <= maxBytes) break;
      const size = Buffer.byteLength(JSON.stringify(entry));
      this.snapshotCache.delete(entry.correlationId);
      this.snapshotCacheBytes = Math.max(0, this.snapshotCacheBytes - size);
    }
  }

  private writeSnapshot(snapshot: WideSnapshot): void {
    const dir = getProcessEventsDir(
      this.workspacePath,
      this.processName ?? 'unknown',
      this.processInstance
    );
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const path = getProcessSnapshotsPath(
      this.workspacePath,
      this.processName ?? 'unknown',
      this.processInstance
    );
    this.ensureSnapshotsLoaded();
    const ordered = Array.from(this.snapshotCache.values()).sort((a, b) => a.updatedAt - b.updatedAt);
    const content = ordered.map((entry) => JSON.stringify(entry)).join('\n');
    writeFileSync(path, content.length > 0 ? `${content}\n` : '', 'utf-8');
  }
}

export function matchFilter(event: WideEvent, filter: WideEventFilter): boolean {
  if (filter.eventName && event.eventName !== filter.eventName) return false;
  if (filter.eventId && event.eventId !== filter.eventId) return false;
  if (filter.level && event.level !== filter.level) return false;
  if (filter.message && !event.message.includes(filter.message)) return false;
  if (filter.processName && event.processName !== filter.processName) return false;
  if (filter.kind && event.kind !== filter.kind) return false;
  if (filter.correlationId && event.correlationId !== filter.correlationId) return false;
  return true;
}
