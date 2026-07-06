/** @jsxImportSource react */
import type { ReactElement } from 'react';
import type { WideEventItem } from './Events.js';

/**
 * ⚑ Event logs as a DOCK PANE (mock Shell EventsPane / .evpane): one flat
 * chronological list — dim mono time column + text, 2px tone-colored left
 * border per row. The full observability browser (filters, timeline,
 * inspector) lives behind "open browser ↗", not on the default surface.
 */

const TONE_BORDER: Record<string, string> = {
  error: 'var(--gs-danger)',
  warn: 'var(--gs-warning)',
  warning: 'var(--gs-warning)',
  info: 'var(--gs-info)',
  success: 'var(--gs-success)',
  ok: 'var(--gs-success)',
};

function toneFor(level: string): string {
  return TONE_BORDER[level.toLowerCase()] ?? 'var(--gs-border-active)';
}

function timeLabel(item: WideEventItem): string {
  const ms = item.timestampMs;
  const d = ms ? new Date(ms) : new Date(item.timestamp);
  if (Number.isNaN(d.getTime())) return item.timestamp.slice(11, 16) || '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function EventLogPane({ events, onOpenBrowser }: {
  events: WideEventItem[];
  /** Open the full observability browser (filters/timeline/inspector). */
  onOpenBrowser?: () => void;
}): ReactElement {
  return (
    <div className="gs-ui relative flex h-full min-h-0 flex-col text-[12px]">
      {onOpenBrowser && (
        <button
          type="button"
          onClick={onOpenBrowser}
          title="Open the full events browser (filters · timeline · inspector)"
          className="absolute right-2 top-1.5 z-10 px-1.5 text-[10.5px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-text)]"
        >
          browser ↗
        </button>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-2.5">
        {events.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[var(--gs-text-muted)]">No events yet</div>
        ) : (
          events.map((e) => (
            <div
              key={e.eventId}
              className="flex items-baseline gap-2.5 px-3.5 py-1.5"
              style={{ borderLeft: `2px solid ${toneFor(e.level)}` }}
            >
              <span className="w-[34px] flex-shrink-0 font-[family-name:var(--gs-font)] text-[10.5px] tabular-nums text-[var(--gs-text-dim)]">{timeLabel(e)}</span>
              <span className="min-w-0 flex-1 text-[12px] text-[var(--gs-text-muted)]">{e.message || e.eventName}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
