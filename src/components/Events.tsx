/**
 * Events - Shared Hook
 */

import { useMemo, useState, useEffect, useCallback } from 'react';

export interface WideEventItem {
  eventId: string;
  eventName: string;
  level: string;
  timestamp: string;
  timestampMs?: number;
  message: string;
  processName?: string;
  processInstance?: number;
  sessionId?: string;
  raw?: Record<string, unknown>;
  kind?: 'source' | 'wide';
  correlationId?: string;
  timeline?: import("../types/events.js").WideEventTimelineItem[];
  timelineMap?: import("../types/events.js").WideSnapshotTimelineMap;
  timelineOrder?: string[];
}

export function toWideEventItem(event: import('../types/events.js').WideEvent): WideEventItem {
  return {
    eventId: event.eventId,
    eventName: event.eventName,
    level: event.level,
    timestamp: event.timestamp,
    timestampMs: event.timestampMs,
    message: event.message,
    processName: event.processName,
    processInstance: event.processInstance,
    sessionId: event.sessionId,
    raw: event.raw,
    kind: event.kind,
    correlationId: event.correlationId,
    timeline: event.timeline,
    timelineMap: event.timelineMap,
    timelineOrder: event.timelineOrder,
  };
}

function getEventTimestamp(event: WideEventItem): number {
  if (typeof event.timestampMs === 'number' && !Number.isNaN(event.timestampMs)) {
    return event.timestampMs;
  }
  const parsed = Date.parse(event.timestamp);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getEventKey(event: WideEventItem): string {
  const processName = event.processName ?? 'unknown';
  const instance = event.processInstance ?? 1;
  const correlation = event.correlationId ?? event.eventId;
  return `${processName}:${instance}:${correlation}`;
}

export interface UseEventsProps {
  events: WideEventItem[];
  liveEventIds: string[];
  savedFilters: import("../types/events.js").SavedEventFilter[];
  onSelectFilter: (filter: import("../types/events.js").SavedEventFilter | null) => void;
  onClose: () => void;
}

export interface UseEventsReturn {
  filtered: WideEventItem[];
  selectedIndex: number;
  selected: WideEventItem | null;
  liveEventIds: string[];
  savedFilters: import("../types/events.js").SavedEventFilter[];
  activeFilterName: string | null;
  selectIndex: (index: number) => void;
  selectSavedFilter: (filter: import("../types/events.js").SavedEventFilter | null) => void;
  close: () => void;
}

export function useEvents(props: UseEventsProps): UseEventsReturn {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeFilterName, setActiveFilterName] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const wideEvents = props.events.filter((event) => event.kind === 'wide');
    return [...wideEvents].sort((a, b) => getEventTimestamp(b) - getEventTimestamp(a));
  }, [props.events]);

  useEffect(() => {
    if (!selectedKey && filtered.length > 0) {
      setSelectedIndex((current) => (current === 0 ? current : 0));
      setSelectedKey(getEventKey(filtered[0]));
      return;
    }

    if (!selectedKey) return;
    const nextIndex = filtered.findIndex((event) => getEventKey(event) === selectedKey);
    if (nextIndex !== -1) {
      setSelectedIndex((current) => (current === nextIndex ? current : nextIndex));
      return;
    }

    if (nextIndex === -1 && filtered.length > 0) {
      setSelectedIndex((current) => (current === 0 ? current : 0));
      setSelectedKey(getEventKey(filtered[0]));
    }
  }, [filtered, selectedKey]);

  const selected = filtered[selectedIndex] ?? null;

  const selectSavedFilter = useCallback((filter: import("../types/events.js").SavedEventFilter | null) => {
    setSelectedIndex(0);
    setSelectedKey(null);
    setActiveFilterName(filter?.name ?? null);
    props.onSelectFilter(filter);
  }, [props.onSelectFilter]);

  const selectIndex = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, filtered.length - 1));
    setSelectedIndex(clamped);
    const selectedEvent = filtered[clamped];
    setSelectedKey(selectedEvent ? getEventKey(selectedEvent) : null);
  }, [filtered]);

  return {
    filtered,
    selectedIndex,
    selected,
    liveEventIds: props.liveEventIds,
    savedFilters: props.savedFilters,
    activeFilterName,
    selectIndex,
    selectSavedFilter,
    close: props.onClose,
  };
}
