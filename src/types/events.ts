/**
 * Types for wide event logging
 */

export interface WideEventTimelineItem {
  eventName: string;
  level: string;
  timestamp: string;
  timestampMs: number;
  message: string;
  raw: Record<string, unknown>;
}

export interface WideSnapshotTimelineEntry extends WideEventTimelineItem {
  key: string;
  eventId: string;
  processName?: string;
  processInstance?: number;
}

export interface WideSnapshotTimelineMap {
  [key: string]: WideSnapshotTimelineEntry;
}

export interface WideSnapshot {
  correlationId: string;
  updatedAt: number;
  processName?: string;
  processInstance?: number;
  level: string;
  message: string;
  eventName: string;
  lastEventId: string;
  timelineMap: WideSnapshotTimelineMap;
  timelineOrder: string[];
  raw?: Record<string, unknown>;
}

export interface WideEvent {
  eventId: string;
  eventName: string;
  level: string;
  timestamp: string;
  timestampMs: number;
  message: string;
  sessionId: string;
  workspaceId: string;
  projectName: string;
  processName?: string;
  processInstance?: number;
  raw: Record<string, unknown>;
  kind?: 'source' | 'wide';
  correlationId?: string;
  timeline?: WideEventTimelineItem[];
  timelineMap?: WideSnapshotTimelineMap;
  timelineOrder?: string[];
}

export interface WideEventFilter {
  eventName?: string;
  eventId?: string;
  level?: string;
  message?: string;
  processName?: string;
  kind?: 'source' | 'wide';
  correlationId?: string;
}

export interface SavedEventFilter {
  name: string;
  filter: WideEventFilter;
  sinceMinutes?: number;
}

export interface EventsConfigFile {
  savedFilters?: SavedEventFilter[];
}

export interface WideEventIndex {
  file: string;
  minTs: number;
  maxTs: number;
  levels: string[];
  eventNames: string[];
  count: number;
}

export interface WideEventQueryResult {
  events: WideEvent[];
  liveEventIds: string[];
}
