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

export function EventLogPane({ events, workspaceLabel, onOpenBrowser }: {
  events: WideEventItem[];
  workspaceLabel?: string;
  /** Open the full observability browser (filters/timeline/inspector). */
  onOpenBrowser?: () => void;
}): ReactElement {
  return (
    <div className="flex h-full min-h-0 flex-col text-[12px]">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border-muted)] px-3.5 py-1.5">
        <span className="text-[var(--gs-accent)]">⚑</span>
        <span className="text-[13px] font-medium text-[var(--gs-text)]">Event logs</span>
        <span className="text-[11px] text-[var(--gs-text-dim)]">live{workspaceLabel ? ` · ${workspaceLabel}` : ''}</span>
        {onOpenBrowser && (
          <button type="button" onClick={onOpenBrowser} className="ml-auto border border-[var(--gs-border)] px-2 py-0.5 text-[11px] text-[var(--gs-text-muted)] hover:border-[var(--gs-border-active)] hover:text-[var(--gs-text)]">
            open browser ↗
          </button>
        )}
      </div>
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
