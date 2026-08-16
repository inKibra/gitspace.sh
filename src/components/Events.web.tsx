/** @jsxImportSource react */
/**
 * Events - Web Display Component
 */

import { useMemo, useState } from 'react';
import type { UseEventsReturn } from './Events.js';

const LEVEL_COLORS: Record<string, string> = {
  error: 'var(--gs-danger)',
  warn: 'var(--gs-warning)',
  info: 'var(--gs-success)',
};

type TimelineBucket = {
  label: string;
  count: number;
};

type TimelinePoint = {
  timestamp?: string;
  timestampMs?: number;
  processName?: string;
  processInstance?: number;
};

function getTimelineTimestamp(event: TimelinePoint): number {
  if (typeof event.timestampMs === 'number' && !Number.isNaN(event.timestampMs)) {
    return event.timestampMs;
  }
  if (typeof event.timestamp === 'string') {
    const parsed = Date.parse(event.timestamp);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function buildTimelineBuckets(events: TimelinePoint[]): TimelineBucket[] {
  if (events.length === 0) return [];
  const timestamps = events.map((event) => getTimelineTimestamp(event));
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const rangeMs = Math.max(1, maxTs - minTs);

  const bucketMs = rangeMs <= 15 * 60_000
    ? 60_000
    : rangeMs <= 2 * 60 * 60_000
      ? 5 * 60_000
      : rangeMs <= 12 * 60 * 60_000
        ? 30 * 60_000
        : 60 * 60_000;

  const bucketCount = Math.max(6, Math.min(36, Math.ceil(rangeMs / bucketMs)));
  const buckets: TimelineBucket[] = Array.from({ length: bucketCount }, (_, index) => ({
    label: formatTimelineLabel(minTs + index * bucketMs),
    count: 0,
  }));

  for (const timestamp of timestamps) {
    const index = Math.min(bucketCount - 1, Math.floor((timestamp - minTs) / bucketMs));
    buckets[index].count += 1;
  }

  return buckets;
}

function formatTimelineLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatEventTime(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return timestamp;
  const date = new Date(parsed);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function formatLevel(level: string): string {
  return level.toLowerCase();
}

export function EventsWeb(props: UseEventsReturn & { workspaceLabel?: string | null; embedded?: boolean }) {
  const { filtered, selected, liveEventIds, savedFilters, activeFilterName, selectIndex, selectSavedFilter, close } = props;
  const [search, setSearch] = useState('');

  const filteredLogs = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return filtered;
    return filtered.filter((event) =>
      event.eventName.toLowerCase().includes(query) ||
      event.message.toLowerCase().includes(query) ||
      event.correlationId?.toLowerCase().includes(query)
    );
  }, [filtered, search]);

  const timelineEvents = useMemo(() => {
    if (!selected) return [] as Array<import('../types/events.js').WideSnapshotTimelineEntry>;
    if (selected.timelineOrder && selected.timelineMap) {
      return selected.timelineOrder
        .map((key: string) => selected.timelineMap?.[key])
        .filter((entry): entry is import('../types/events.js').WideSnapshotTimelineEntry => Boolean(entry));
    }
    if (selected.timeline && selected.timeline.length > 0) {
      return selected.timeline.map((entry, index) => ({
        ...entry,
        key: `${entry.eventName}-${index + 1}`,
        eventId: `${entry.eventName}-${index + 1}`,
        processName: selected.processName,
        processInstance: selected.processInstance,
      }));
    }
    return [] as Array<import('../types/events.js').WideSnapshotTimelineEntry>;
  }, [selected]);

  const timelineBuckets = useMemo(() => buildTimelineBuckets(timelineEvents), [timelineEvents]);
  const timelineMax = Math.max(1, ...timelineBuckets.map((bucket) => bucket.count));

  const wideEvent = selected ?? null;

  const processLabel = selected?.processName
    ? `${selected.processName}${selected.processInstance ? `-${selected.processInstance}` : ''}`
    : null;

  return (
    <div className={`events-root w-full flex flex-col bg-[var(--gs-bg)] min-h-0 ${props.embedded ? 'h-full' : 'h-visual-viewport'}`}>
      {!props.embedded && <Header onBack={close} workspaceLabel={props.workspaceLabel} processLabel={processLabel} />}
      <div className="events-column flex-1 flex overflow-hidden min-h-0">
        <div className="w-[38%] min-w-[320px] border-r border-[var(--gs-border)] flex flex-col min-h-0">
          <div className="p-4 space-y-4 border-b border-[var(--gs-border)]">
            <div>
              <div className="text-xs text-[var(--gs-text-dim)] uppercase tracking-wide mb-2">Saved Filters</div>
              <div className="space-y-2">
                <button
                  onClick={() => selectSavedFilter(null)}
                  className={`w-full text-left text-xs truncate px-2 py-1 rounded ${activeFilterName === null ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-elevated)]'}`}
                >
                  All events
                </button>
                {savedFilters.length === 0 ? (
                  <div className="text-xs text-[var(--gs-text-muted)]">No saved filters</div>
                ) : (
                  savedFilters.map((filter) => {
                    const isActive = filter.name === activeFilterName;
                    return (
                      <button
                        key={filter.name}
                        onClick={() => selectSavedFilter(filter)}
                        className={`w-full text-left text-xs truncate px-2 py-1 rounded ${isActive ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-elevated)]'}`}
                      >
                        {filter.name}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-[var(--gs-text-dim)] uppercase tracking-wide mb-2">Search</div>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search event name or message"
                className="w-full rounded bg-[var(--gs-bg)] border border-[var(--gs-border)] px-2 py-1 text-sm text-[var(--gs-text)] placeholder:text-[var(--gs-text-dim)] focus:outline-none focus:border-[var(--gs-info)]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs text-[var(--gs-text-muted)]">
              <div>
                <div className="text-[var(--gs-text-dim)]">Events</div>
                <div className="text-[var(--gs-text)] text-sm">{filteredLogs.length}</div>
              </div>
              <div>
                <div className="text-[var(--gs-text-dim)]">Live</div>
                <div className="text-[var(--gs-text)] text-sm">{liveEventIds.length}</div>
              </div>
              <div>
                <div className="text-[var(--gs-text-dim)]">Errors</div>
                <div className="text-[var(--gs-text)] text-sm">
                  {filteredLogs.filter((event) => formatLevel(event.level) === 'error').length}
                </div>
              </div>
              <div>
                <div className="text-[var(--gs-text-dim)]">Warnings</div>
                <div className="text-[var(--gs-text)] text-sm">
                  {filteredLogs.filter((event) => formatLevel(event.level) === 'warn').length}
                </div>
              </div>
            </div>
          </div>
          <div className="events-scroll flex-1 overflow-y-auto min-h-0">
              {filteredLogs.length === 0 ? (
                <div className="text-[var(--gs-text-muted)] text-center py-8">No wide events</div>
              ) : (
                filteredLogs.map((event, index) => {
                  const isSelected = selected?.eventId === event.eventId;
                  const level = formatLevel(event.level);
                  const levelColor = LEVEL_COLORS[level] ?? 'var(--gs-text-muted)';
                  return (
                    <div
                      key={`${event.eventId}-${index}`}
                      onClick={() => {
                        const baseIndex = filtered.findIndex((item) => item.eventId === event.eventId);
                        if (baseIndex >= 0) {
                          selectIndex(baseIndex);
                        }
                      }}
                      className={`px-4 py-3 border-b border-[var(--gs-border)] cursor-pointer ${isSelected ? 'bg-[var(--gs-bg-active)] border-l-4 border-l-[var(--gs-info)]' : 'hover:bg-[var(--gs-bg-elevated)]'}`}
                    >
                      <div className="flex items-center gap-2 text-xs text-[var(--gs-text-dim)]">
                        <div className="uppercase" style={{ color: levelColor }}>{level}</div>
                        <div>·</div>
                        <div>{formatEventTime(event.timestamp)}</div>
                        {event.processName && <div className="text-[var(--gs-text-dim)]">{event.processName}</div>}
                      </div>
                      <div className="text-[var(--gs-text)] text-sm font-medium truncate">
                        Wide event {event.correlationId ? `· ${event.correlationId}` : ''}
                      </div>
                      <div className="text-[var(--gs-text-muted)] text-xs truncate">{event.message}</div>
                    </div>
                  );
                })
              )}

          </div>
        </div>
        <div className="flex-1 flex flex-col min-h-0">
            <div className="border-b border-[var(--gs-border)] p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs text-[var(--gs-text-dim)] uppercase tracking-wide">
                  {selected ? `${selected.eventName} timeline` : 'All events timeline'}
                </div>
                <div className="text-xs text-[var(--gs-text-dim)]">{timelineEvents.length} events</div>
              </div>
              {timelineBuckets.length === 0 ? (
                <div className="text-[var(--gs-text-muted)] text-sm">No timeline data</div>
              ) : (
                <div className="flex items-end gap-1 h-24">
                  {timelineBuckets.map((bucket, index) => (
                    <div key={`${bucket.label}-${index}`} className="flex-1 flex flex-col items-center gap-2">
                      <div
                        className="w-full rounded bg-[var(--gs-border)]"
                        style={{
                          height: `${Math.max(6, (bucket.count / timelineMax) * 96)}px`,
                          backgroundColor: selected ? 'var(--gs-info)' : 'var(--gs-success)',
                        }}
                      />
                      <div className="text-[10px] text-[var(--gs-text-dim)] truncate w-full text-center">
                        {bucket.label}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="events-scroll flex-1 overflow-y-auto p-4 min-h-0">
            {selected ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[var(--gs-text)] text-lg font-semibold">Wide Event</div>
                    <div className="text-xs text-[var(--gs-text-dim)]">{selected.correlationId ?? selected.eventId}</div>
                  </div>
                  {wideEvent && (
                    <button
                      onClick={() => navigator.clipboard.writeText(JSON.stringify(wideEvent.raw ?? wideEvent, null, 2))}
                      className="text-xs px-2 py-1 rounded bg-[var(--gs-btn-secondary-bg)] hover:bg-[var(--gs-border)] text-[var(--gs-text)]"
                    >
                      Copy JSON
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm text-[var(--gs-text-muted)]">
                  <div>
                    <div className="text-xs text-[var(--gs-text-dim)]">Latest Level</div>
                    <div className="text-[var(--gs-text)]">{formatLevel(selected.level)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-[var(--gs-text-dim)]">Latest Timestamp</div>
                    <div className="text-[var(--gs-text)]">{selected.timestamp}</div>
                  </div>
                  <div>
                    <div className="text-xs text-[var(--gs-text-dim)]">Process</div>
                    <div className="text-[var(--gs-text)]">
                      {selected.processName ? `${selected.processName}${selected.processInstance ? `#${selected.processInstance}` : ''}` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-[var(--gs-text-dim)]">Session</div>
                    <div className="text-[var(--gs-text)]">{selected.sessionId ?? '—'}</div>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-[var(--gs-text-dim)] uppercase tracking-wide mb-2">Latest Message</div>
                  <div className="text-[var(--gs-text)] text-sm">{selected.message}</div>
                </div>
                <div>
                  <div className="text-xs text-[var(--gs-text-dim)] uppercase tracking-wide mb-2">Source Timeline</div>
                  {timelineEvents.length > 0 ? (
                    <div className="space-y-2">
                      {timelineEvents.map((item, index) => (
                        <div key={`${item.eventName}-${index}`} className="border border-[var(--gs-border)] rounded px-3 py-2">
                          <div className="flex items-center gap-2 text-xs text-[var(--gs-text-dim)]">
                            <div className="uppercase" style={{ color: LEVEL_COLORS[formatLevel(item.level)] ?? 'var(--gs-text-muted)' }}>
                              {formatLevel(item.level)}
                            </div>
                            <div>·</div>
                            <div>{formatEventTime(item.timestamp)}</div>
                          </div>
                          <div className="text-sm text-[var(--gs-text)]">{item.eventName}</div>
                          <div className="text-xs text-[var(--gs-text-muted)]">{item.message}</div>
                          {typeof item.processName === 'string' && (
                            <div className="text-[11px] text-[var(--gs-text-dim)]">
                              {item.processName}
                              {typeof item.processInstance === 'number' ? `#${item.processInstance}` : ''}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[var(--gs-text-muted)] text-sm">Collecting timeline...</div>
                  )}
                </div>
                {wideEvent && (
                  <div>
                    <div className="text-xs text-[var(--gs-text-dim)] uppercase tracking-wide mb-2">Raw Wide Event</div>
                    <pre className="text-xs bg-[var(--gs-bg)] border border-[var(--gs-border)] rounded p-3 text-[var(--gs-text)] overflow-x-auto">
                      {JSON.stringify(wideEvent.raw ?? wideEvent, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[var(--gs-text-muted)]">Select a wide event to inspect</div>
            )}

            </div>

        </div>
      </div>
    </div>
  );
}

function Header({
  onBack,
  workspaceLabel,
  processLabel,
}: {
  onBack: () => void;
  workspaceLabel?: string | null;
  processLabel?: string | null;
}) {
  return (
    <div className="bg-[var(--gs-bg-elevated)] px-4 py-3 flex items-center justify-between border-b border-[var(--gs-border)]">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="text-sm text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] active:text-[var(--gs-accent)] py-2 pr-2 -ml-2 min-h-[44px] flex items-center"
        >
          ← <span className="hidden sm:inline ml-1">Back</span>
        </button>
        <div>
          <div className="text-[var(--gs-text)] font-medium">Events</div>
          {workspaceLabel && (
            <div className="text-xs text-[var(--gs-text-dim)]">Workspace: {workspaceLabel}</div>
          )}
          {processLabel && (
            <div className="text-xs text-[var(--gs-text-dim)]">Process: {processLabel}</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-[var(--gs-text-dim)]">
        <span>J/K: Navigate</span>
        <span>Esc: Close</span>
      </div>
    </div>
  );
}
