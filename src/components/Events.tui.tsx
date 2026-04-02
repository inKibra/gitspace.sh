/** @jsxImportSource @opentui/react */
/**
 * Events - TUI Display Component
 */

import type { UseEventsReturn } from './Events.js';

const COLORS = {
  border: '#555555',
  title: '#00FF88',
  text: '#FFFFFF',
  textDim: '#888888',
  selected: '#00AAFF',
  info: '#3fb950',
  warn: '#d29922',
  error: '#f85149',
};

type TimelineEntry = {
  eventName: string;
  level: string;
  timestamp: string;
  message: string;
};

function formatEventTime(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return timestamp;
  const date = new Date(parsed);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

function getLevelColor(level: string): string {
  const normalized = level.toLowerCase();
  if (normalized === 'error') return COLORS.error;
  if (normalized === 'warn') return COLORS.warn;
  return COLORS.info;
}

export function EventsTui(props: UseEventsReturn) {
  const { filtered, selectedIndex, selected, showingSourceEvents } = props;
  const timeline = (selected?.timeline ?? []) as TimelineEntry[];

  return (
    <box flexDirection="column" flexGrow={1} width="100%" height="100%">
      <box
        flexDirection="row"
        height={1}
        width="100%"
        backgroundColor="#222222"
        paddingLeft={1}
        paddingRight={1}
      >
        <text fg={COLORS.title}>Events</text>
        <text fg={COLORS.textDim}> - {showingSourceEvents ? 'Source events' : 'Wide events'}</text>
        <box flexGrow={1} />
        <text fg={COLORS.textDim}>[Esc] Back</text>
      </box>
      <box flexDirection="row" flexGrow={1} width="100%">
        <box
          flexDirection="column"
          width="45%"
          border
          borderStyle="single"
          borderColor={COLORS.border}
        >
          <text fg={COLORS.title} paddingLeft={1} height={1}>
            {' '}Wide events{' '}
          </text>
          <box flexDirection="column" paddingLeft={1} paddingTop={1} flexGrow={1} overflow="scroll">
            {filtered.length === 0 ? (
              <text fg={COLORS.textDim}>No events yet for this workspace.</text>
            ) : (
              filtered.map((event, index) => {
                const isSelected = index === selectedIndex;
                const prefix = isSelected ? '>' : ' ';
                const levelColor = getLevelColor(event.level);
                return (
                  <box key={event.eventId} flexDirection="row" height={1}>
                    <text fg={isSelected ? COLORS.selected : COLORS.textDim}>{prefix}</text>
                    <text fg={levelColor}> {event.level.toUpperCase()}</text>
                    <text fg={COLORS.textDim}> {formatEventTime(event.timestamp)}</text>
                    <text fg={isSelected ? COLORS.text : COLORS.textDim}> {event.correlationId ?? event.eventId}</text>
                  </box>
                );
              })
            )}
          </box>
        </box>
        <box flexDirection="column" flexGrow={1} border borderStyle="single" borderColor={COLORS.border}>
          <text fg={COLORS.title} paddingLeft={1} height={1}>
            {' '}Timeline{' '}
          </text>
          <box flexDirection="column" paddingLeft={1} paddingTop={1} flexGrow={1} overflow="scroll">
            {selected ? (
              <box flexDirection="column">
                <text fg={COLORS.text} height={1}>Correlation: {selected.correlationId ?? selected.eventId}</text>
                <text fg={COLORS.textDim} height={1}>Type: {selected.kind ?? 'wide'}</text>
                <text fg={COLORS.textDim} height={1}>Latest: {selected.message}</text>
                {selected.processName && (
                  <text fg={COLORS.textDim} height={1}>Process: {selected.processName}</text>
                )}
                {selected.sessionId && (
                  <text fg={COLORS.textDim} height={1}>Session: {selected.sessionId}</text>
                )}
                <box height={1} />
                {timeline.length === 0 ? (
                  <text fg={COLORS.textDim}>Collecting timeline...</text>
                ) : (
                  timeline.map((item, index) => (
                    <box key={`${item.eventName}-${index}`} flexDirection="row" height={1}>
                      <text fg={getLevelColor(item.level)}>{item.level.toUpperCase()}</text>
                      <text fg={COLORS.textDim}> {formatEventTime(item.timestamp)}</text>
                      <text fg={COLORS.text}> {item.eventName}</text>
                      <text fg={COLORS.textDim}> - {item.message}</text>
                    </box>
                  ))
                )}
              </box>
            ) : (
              <text fg={COLORS.textDim}>Select a wide event to inspect.</text>
            )}
          </box>
        </box>
      </box>
    </box>
  );
}
