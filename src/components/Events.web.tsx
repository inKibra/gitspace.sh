/** @jsxImportSource react */
/**
 * Events - Web Display Component
 */

import { useMemo, useState } from 'react';
import type { UseEventsReturn } from './Events.js';

const LEVEL_COLORS: Record<string, string> = {
  error: '#f85149',
  warn: '#d29922',
  info: '#3fb950',
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

export function EventsWeb(props: UseEventsReturn & { workspaceLabel?: string | null }) {
  const { filtered, selectedIndex, selected, liveEventIds, savedFilters, activeFilterName, selectIndex, selectSavedFilter, close } = props;
  const [search, setSearch] = useState('');

  const filteredLogs = useMemo(() => {
    const query = search.trim().toLowerCase();
    const wideEvents = filtered.filter((event) => event.kind === 'wide');
    if (!query) return wideEvents;
    return wideEvents.filter((event) =>
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
  }, [filtered, selected]);

  const timelineBuckets = useMemo(() => buildTimelineBuckets(timelineEvents), [timelineEvents]);
  const timelineMax = Math.max(1, ...timelineBuckets.map((bucket) => bucket.count));

  const wideEvent = selected ?? null;

  const processLabel = selected?.processName
    ? `${selected.processName}${selected.processInstance ? `-${selected.processInstance}` : ''}`
    : null;

  return (
    <div className="events-root h-visual-viewport w-full flex flex-col bg-[#0d1117] min-h-0">
      <Header onBack={close} workspaceLabel={props.workspaceLabel} processLabel={processLabel} />
      <div className="events-column flex-1 flex overflow-hidden min-h-0">
        <div className="w-[38%] min-w-[320px] border-r border-[#30363d] flex flex-col min-h-0">
          <div className="p-4 space-y-4 border-b border-[#30363d]">
            <div>
              <div className="text-xs text-[#6e7681] uppercase tracking-wide mb-2">Saved Filters</div>
              <div className="space-y-2">
                <button
                  onClick={() => selectSavedFilter(null)}
                  className={`w-full text-left text-xs truncate px-2 py-1 rounded ${activeFilterName === null ? 'bg-[#21262d] text-[#e6edf3]' : 'text-[#8b949e] hover:bg-[#161b22]'}`}
                >
                  All events
                </button>
                {savedFilters.length === 0 ? (
                  <div className="text-xs text-[#8b949e]">No saved filters</div>
                ) : (
                  savedFilters.map((filter) => {
                    const isActive = filter.name === activeFilterName;
                    return (
                      <button
                        key={filter.name}
                        onClick={() => selectSavedFilter(filter)}
                        className={`w-full text-left text-xs truncate px-2 py-1 rounded ${isActive ? 'bg-[#21262d] text-[#e6edf3]' : 'text-[#8b949e] hover:bg-[#161b22]'}`}
                      >
                        {filter.name}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            <div>
              <div className="text-xs text-[#6e7681] uppercase tracking-wide mb-2">Search</div>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search event name or message"
                className="w-full rounded bg-[#0d1117] border border-[#30363d] px-2 py-1 text-sm text-[#e6edf3] placeholder:text-[#6e7681] focus:outline-none focus:border-[#58a6ff]"
              />
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs text-[#8b949e]">
              <div>
                <div className="text-[#6e7681]">Events</div>
                <div className="text-[#e6edf3] text-sm">{filteredLogs.length}</div>
              </div>
              <div>
                <div className="text-[#6e7681]">Live</div>
                <div className="text-[#e6edf3] text-sm">{liveEventIds.length}</div>
              </div>
              <div>
                <div className="text-[#6e7681]">Errors</div>
                <div className="text-[#e6edf3] text-sm">
                  {filteredLogs.filter((event) => formatLevel(event.level) === 'error').length}
                </div>
              </div>
              <div>
                <div className="text-[#6e7681]">Warnings</div>
                <div className="text-[#e6edf3] text-sm">
                  {filteredLogs.filter((event) => formatLevel(event.level) === 'warn').length}
                </div>
              </div>
            </div>
          </div>
          <div className="events-scroll flex-1 overflow-y-auto min-h-0">
              {filteredLogs.length === 0 ? (
                <div className="text-[#8b949e] text-center py-8">No wide events</div>
              ) : (
                filteredLogs.map((event, index) => {
                  const selectedEvent = filteredLogs[selectedIndex];
                  const isSelected = selectedEvent?.eventId === event.eventId;
                  const level = formatLevel(event.level);
                  const levelColor = LEVEL_COLORS[level] ?? '#8b949e';
                  return (
                    <div
                      key={`${event.eventId}-${index}`}
                      onClick={() => selectIndex(index)}
                      className={`px-4 py-3 border-b border-[#30363d] cursor-pointer ${isSelected ? 'bg-[#21262d] border-l-4 border-l-[#58a6ff]' : 'hover:bg-[#161b22]'}`}
                    >
                      <div className="flex items-center gap-2 text-xs text-[#6e7681]">
                        <div className="uppercase" style={{ color: levelColor }}>{level}</div>
                        <div>·</div>
                        <div>{formatEventTime(event.timestamp)}</div>
                        {event.processName && <div className="text-[#6e7681]">{event.processName}</div>}
                      </div>
                      <div className="text-[#e6edf3] text-sm font-medium truncate">
                        Wide event {event.correlationId ? `· ${event.correlationId}` : ''}
                      </div>
                      <div className="text-[#8b949e] text-xs truncate">{event.message}</div>
                    </div>
                  );
                })
              )}

          </div>
        </div>
        <div className="flex-1 flex flex-col min-h-0">
            <div className="border-b border-[#30363d] p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs text-[#6e7681] uppercase tracking-wide">
                  {selected ? `${selected.eventName} timeline` : 'All events timeline'}
                </div>
                <div className="text-xs text-[#6e7681]">{timelineEvents.length} events</div>
              </div>
              {timelineBuckets.length === 0 ? (
                <div className="text-[#8b949e] text-sm">No timeline data</div>
              ) : (
                <div className="flex items-end gap-1 h-24">
                  {timelineBuckets.map((bucket, index) => (
                    <div key={`${bucket.label}-${index}`} className="flex-1 flex flex-col items-center gap-2">
                      <div
                        className="w-full rounded bg-[#30363d]"
                        style={{
                          height: `${Math.max(6, (bucket.count / timelineMax) * 96)}px`,
                          backgroundColor: selected ? '#58a6ff' : '#3fb950',
                        }}
                      />
                      <div className="text-[10px] text-[#6e7681] truncate w-full text-center">
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
                    <div className="text-[#e6edf3] text-lg font-semibold">Wide Event</div>
                    <div className="text-xs text-[#6e7681]">{selected.correlationId ?? selected.eventId}</div>
                  </div>
                  {wideEvent && (
                    <button
                      onClick={() => navigator.clipboard.writeText(JSON.stringify(wideEvent.raw ?? wideEvent, null, 2))}
                      className="text-xs px-2 py-1 rounded bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3]"
                    >
                      Copy JSON
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm text-[#8b949e]">
                  <div>
                    <div className="text-xs text-[#6e7681]">Latest Level</div>
                    <div className="text-[#e6edf3]">{formatLevel(selected.level)}</div>
                  </div>
                  <div>
                    <div className="text-xs text-[#6e7681]">Latest Timestamp</div>
                    <div className="text-[#e6edf3]">{selected.timestamp}</div>
                  </div>
                  <div>
                    <div className="text-xs text-[#6e7681]">Process</div>
                    <div className="text-[#e6edf3]">
                      {selected.processName ? `${selected.processName}${selected.processInstance ? `#${selected.processInstance}` : ''}` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-[#6e7681]">Session</div>
                    <div className="text-[#e6edf3]">{selected.sessionId ?? '—'}</div>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-[#6e7681] uppercase tracking-wide mb-2">Latest Message</div>
                  <div className="text-[#e6edf3] text-sm">{selected.message}</div>
                </div>
                <div>
                  <div className="text-xs text-[#6e7681] uppercase tracking-wide mb-2">Source Timeline</div>
                  {timelineEvents.length > 0 ? (
                    <div className="space-y-2">
                      {timelineEvents.map((item, index) => (
                        <div key={`${item.eventName}-${index}`} className="border border-[#30363d] rounded px-3 py-2">
                          <div className="flex items-center gap-2 text-xs text-[#6e7681]">
                            <div className="uppercase" style={{ color: LEVEL_COLORS[formatLevel(item.level)] ?? '#8b949e' }}>
                              {formatLevel(item.level)}
                            </div>
                            <div>·</div>
                            <div>{formatEventTime(item.timestamp)}</div>
                          </div>
                          <div className="text-sm text-[#e6edf3]">{item.eventName}</div>
                          <div className="text-xs text-[#8b949e]">{item.message}</div>
                          {typeof item.processName === 'string' && (
                            <div className="text-[11px] text-[#6e7681]">
                              {item.processName}
                              {typeof item.processInstance === 'number' ? `#${item.processInstance}` : ''}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[#8b949e] text-sm">Collecting timeline...</div>
                  )}
                </div>
                {wideEvent && (
                  <div>
                    <div className="text-xs text-[#6e7681] uppercase tracking-wide mb-2">Raw Wide Event</div>
                    <pre className="text-xs bg-[#0d1117] border border-[#30363d] rounded p-3 text-[#e6edf3] overflow-x-auto">
                      {JSON.stringify(wideEvent.raw ?? wideEvent, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-[#8b949e]">Select a wide event to inspect</div>
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
    <div className="bg-[#161b22] px-4 py-3 flex items-center justify-between border-b border-[#30363d]">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="text-sm text-[#8b949e] hover:text-[#e6edf3] active:text-[#22c55e] py-2 pr-2 -ml-2 min-h-[44px] flex items-center"
        >
          ← <span className="hidden sm:inline ml-1">Back</span>
        </button>
        <div>
          <div className="text-[#e6edf3] font-medium">Events</div>
          {workspaceLabel && (
            <div className="text-xs text-[#6e7681]">Workspace: {workspaceLabel}</div>
          )}
          {processLabel && (
            <div className="text-xs text-[#6e7681]">Last update: {processLabel}</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 text-xs text-[#6e7681]">
        <span>J/K: Navigate</span>
        <span>Esc: Close</span>
      </div>
    </div>
  );
}

